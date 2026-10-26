// Pure core: dense (embedding) half of the hybrid RAG.
//
// The live path never waits on the network and never waits long on the CPU:
//   - passage embeddings are computed once per goal, in the background, and
//     cached on disk (keyed by a fingerprint of the model + chunk texts);
//   - the question embedding runs on one dedicated worker thread; a search
//     waits for it at most `budget` and otherwise returns nothing, so the
//     caller falls back to BM25 alone (the late result is still cached for
//     the next call with the same text, e.g. the commit after a speculation);
//   - the vector search itself is a brute-force dot product over a few
//     hundred normalized rows (well under 0.1 ms).
#pragma once

#include <algorithm>
#include <cmath>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace rtai {

struct DenseHit {
    std::size_t index{0}; // chunk index in MiniAgentRag
    float score{0.0f};    // cosine similarity (vectors are L2-normalized)
};

// Text -> L2-normalized vector. `is_query` selects the model's query/passage
// convention (e5: "query: " / "passage: " prefixes). Called from one thread
// at a time (the EmbeddingDenseSearch worker).
class IEmbedder {
public:
    virtual ~IEmbedder() = default;
    [[nodiscard]] virtual std::size_t dim() const noexcept = 0;
    [[nodiscard]] virtual std::string model_id() const = 0;
    virtual bool embed(std::string_view text, bool is_query, std::vector<float>& out) = 0;
};

// What MiniAgentRag consumes. search() must be safe to call from any thread
// and must never block longer than its own budget.
class IDenseSearch {
public:
    virtual ~IDenseSearch() = default;
    [[nodiscard]] virtual std::vector<DenseHit> search(std::string_view query, std::size_t k) = 0;
    // Hint that `query` will probably be searched soon (starts the embedding).
    virtual void prefetch(std::string_view /*query*/) {}
};

namespace dense {

inline std::uint64_t fnv1a(std::string_view s, std::uint64_t h = 1469598103934665603ULL) noexcept {
    for (unsigned char c : s) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// Identity of an index: model + every passage text, in order. Any change in
// the materials, the chunker or the model gives a new fingerprint.
inline std::string fingerprint(std::string_view model_id, const std::vector<std::string>& passages) {
    std::uint64_t h = fnv1a(model_id);
    h = fnv1a("\x1f", h);
    for (const auto& p : passages) {
        h = fnv1a(p, h);
        h = fnv1a("\x1e", h);
    }
    static const char* hex = "0123456789abcdef";
    std::string out(16, '0');
    for (int i = 15; i >= 0; --i) {
        out[static_cast<std::size_t>(i)] = hex[h & 0xF];
        h >>= 4;
    }
    return out + "-" + std::to_string(passages.size());
}

inline void l2_normalize(std::vector<float>& v) noexcept {
    double s = 0.0;
    for (float x : v) s += static_cast<double>(x) * x;
    if (s <= 0.0) return;
    const float inv = static_cast<float>(1.0 / std::sqrt(s));
    for (float& x : v) x *= inv;
}

// Cache key for a question: whitespace collapsed, trimmed (case is kept: the
// model sees it).
inline std::string query_key(std::string_view q) {
    std::string out;
    out.reserve(q.size());
    bool space = false;
    for (char c : q) {
        const bool ws = c == ' ' || c == '\t' || c == '\n' || c == '\r';
        if (ws) { space = !out.empty(); continue; }
        if (space) out.push_back(' ');
        space = false;
        out.push_back(c);
    }
    return out;
}

} // namespace dense

// Lets the app attach the dense side before it exists: the model and the
// index load in the background (hundreds of ms) while retrieval already
// runs, BM25 only, until set() publishes the real search.
class DeferredDenseSearch final : public IDenseSearch {
public:
    void set(std::shared_ptr<IDenseSearch> inner) {
        std::lock_guard<std::mutex> lk(mu_);
        inner_ = std::move(inner);
    }
    [[nodiscard]] std::shared_ptr<IDenseSearch> get() const {
        std::lock_guard<std::mutex> lk(mu_);
        return inner_;
    }
    std::vector<DenseHit> search(std::string_view query, std::size_t k) override {
        auto in = get();
        return in ? in->search(query, k) : std::vector<DenseHit>{};
    }
    void prefetch(std::string_view query) override {
        if (auto in = get()) in->prefetch(query);
    }

private:
    mutable std::mutex mu_;
    std::shared_ptr<IDenseSearch> inner_;
};

// Row-major matrix of normalized passage vectors.
class DenseIndex {
public:
    explicit DenseIndex(std::size_t dim = 0) : dim_(dim) {}

    [[nodiscard]] std::size_t dim() const noexcept { return dim_; }
    [[nodiscard]] std::size_t size() const noexcept { return dim_ ? data_.size() / dim_ : 0; }

    bool add(const std::vector<float>& v) {
        if (dim_ == 0) dim_ = v.size();
        if (v.size() != dim_ || dim_ == 0) return false;
        data_.insert(data_.end(), v.begin(), v.end());
        return true;
    }

    [[nodiscard]] std::vector<DenseHit> top_k(const std::vector<float>& q, std::size_t k, float min_score = -1.0f) const {
        std::vector<DenseHit> hits;
        if (q.size() != dim_ || dim_ == 0 || k == 0) return hits;
        const std::size_t n = size();
        hits.reserve(n);
        const float* row = data_.data();
        for (std::size_t i = 0; i < n; ++i, row += dim_) {
            float s = 0.0f;
            for (std::size_t j = 0; j < dim_; ++j) s += row[j] * q[j];
            if (s >= min_score) hits.push_back(DenseHit{i, s});
        }
        const std::size_t keep = std::min(k, hits.size());
        std::partial_sort(hits.begin(), hits.begin() + static_cast<std::ptrdiff_t>(keep), hits.end(),
                          [](const DenseHit& a, const DenseHit& b) {
                              return a.score != b.score ? a.score > b.score : a.index < b.index;
                          });
        hits.resize(keep);
        return hits;
    }

    // "RTAIEMB1" | fp len u32 | fp | dim u32 | n u32 | floats (little-endian host order).
    [[nodiscard]] std::string serialize(std::string_view fp) const {
        std::string out = "RTAIEMB1";
        auto put32 = [&](std::uint32_t v) { out.append(reinterpret_cast<const char*>(&v), 4); };
        put32(static_cast<std::uint32_t>(fp.size()));
        out.append(fp);
        put32(static_cast<std::uint32_t>(dim_));
        put32(static_cast<std::uint32_t>(size()));
        out.append(reinterpret_cast<const char*>(data_.data()), data_.size() * sizeof(float));
        return out;
    }

    static std::optional<DenseIndex> deserialize(std::string_view bytes, std::string_view expected_fp) {
        std::size_t p = 0;
        auto get32 = [&](std::uint32_t& v) {
            if (p + 4 > bytes.size()) return false;
            std::memcpy(&v, bytes.data() + p, 4);
            p += 4;
            return true;
        };
        if (bytes.size() < 8 || bytes.substr(0, 8) != "RTAIEMB1") return std::nullopt;
        p = 8;
        std::uint32_t fl = 0, dim = 0, n = 0;
        if (!get32(fl) || p + fl > bytes.size()) return std::nullopt;
        if (bytes.substr(p, fl) != expected_fp) return std::nullopt;
        p += fl;
        if (!get32(dim) || !get32(n) || dim == 0 || dim > 8192) return std::nullopt;
        const std::size_t need = static_cast<std::size_t>(dim) * n * sizeof(float);
        if (bytes.size() - p != need) return std::nullopt;
        DenseIndex idx(dim);
        idx.data_.resize(static_cast<std::size_t>(dim) * n);
        std::memcpy(idx.data_.data(), bytes.data() + p, need);
        return idx;
    }

private:
    std::size_t dim_{0};
    std::vector<float> data_;
};

// IDenseSearch backed by an embedder running on its own worker thread.
class EmbeddingDenseSearch final : public IDenseSearch {
public:
    struct Options {
        // Longest a search waits for the question embedding. Past it the
        // caller goes on with BM25 only; 0 = use only already-cached queries.
        std::chrono::microseconds budget{std::chrono::milliseconds(12)};
        std::size_t cache_size{64};
        // Passages below this cosine are not returned at all.
        float min_score{0.0f};
        // Run one throwaway embedding at start (the first ONNX run is slow).
        bool warm_up{true};
    };

    // Shared counters (for logs and tests).
    struct Stats {
        std::uint64_t searches{0};
        std::uint64_t cache_hits{0};
        std::uint64_t timeouts{0};
        std::uint64_t not_ready{0};
        double last_wait_ms{0.0};
        double last_embed_ms{0.0};
        bool index_ready{false};
        std::size_t indexed{0};
        bool loaded_from_cache{false};
    };

    using CacheLoad = std::function<std::optional<std::string>(const std::string& fingerprint)>;
    using CacheStore = std::function<void(const std::string& fingerprint, const std::string& bytes)>;

    EmbeddingDenseSearch(std::shared_ptr<IEmbedder> embedder, Options opts)
        : embedder_(std::move(embedder)), opts_(opts) {
        worker_ = std::thread([this] { run(); });
    }
    explicit EmbeddingDenseSearch(std::shared_ptr<IEmbedder> embedder)
        : EmbeddingDenseSearch(std::move(embedder), Options{}) {}

    ~EmbeddingDenseSearch() override {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_work_.notify_all();
        cv_done_.notify_all();
        if (worker_.joinable()) worker_.join();
    }

    EmbeddingDenseSearch(const EmbeddingDenseSearch&) = delete;
    EmbeddingDenseSearch& operator=(const EmbeddingDenseSearch&) = delete;

    // Starts (or replaces) the passage index. The cache is tried first; on a
    // miss the passages are embedded one by one, always yielding to pending
    // questions, and the finished index is stored back.
    void build_index(std::vector<std::string> passages, CacheLoad load = {}, CacheStore store = {}) {
        std::lock_guard<std::mutex> lk(mu_);
        build_ = std::make_shared<BuildJob>();
        build_->passages = std::move(passages);
        build_->load = std::move(load);
        build_->store = std::move(store);
        index_.reset();
        stats_.index_ready = false;
        stats_.indexed = 0;
        stats_.loaded_from_cache = false;
        cv_work_.notify_all();
    }

    [[nodiscard]] bool ready() const {
        std::lock_guard<std::mutex> lk(mu_);
        return index_ != nullptr;
    }

    // Blocks until the index is ready (tests and tools only, never the live path).
    bool wait_ready(std::chrono::milliseconds timeout) {
        std::unique_lock<std::mutex> lk(mu_);
        return cv_done_.wait_for(lk, timeout, [&] { return index_ != nullptr || stop_; }) && index_ != nullptr;
    }

    [[nodiscard]] Stats stats() const {
        std::lock_guard<std::mutex> lk(mu_);
        return stats_;
    }

    [[nodiscard]] std::string model_id() const { return embedder_ ? embedder_->model_id() : std::string{}; }

    void prefetch(std::string_view query) override {
        std::string key = dense::query_key(query);
        if (key.empty()) return;
        std::lock_guard<std::mutex> lk(mu_);
        if (cache_find(key)) return;
        enqueue(std::move(key));
        cv_work_.notify_all();
    }

    std::vector<DenseHit> search(std::string_view query, std::size_t k) override {
        const auto t0 = std::chrono::steady_clock::now();
        std::string key = dense::query_key(query);
        std::shared_ptr<const DenseIndex> idx;
        std::shared_ptr<const std::vector<float>> qv;
        {
            std::unique_lock<std::mutex> lk(mu_);
            ++stats_.searches;
            if (!index_ || key.empty()) {
                ++stats_.not_ready;
                return {};
            }
            idx = index_;
            qv = cache_find(key);
            if (qv) {
                ++stats_.cache_hits;
            } else {
                enqueue(key);
                cv_work_.notify_all();
                if (opts_.budget.count() > 0) {
                    cv_done_.wait_for(lk, opts_.budget, [&] {
                        if (stop_) return true;
                        qv = cache_find(key);
                        return qv != nullptr;
                    });
                }
                if (!qv) ++stats_.timeouts;
            }
            stats_.last_wait_ms =
                std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        }
        if (!qv) return {};
        return idx->top_k(*qv, k, opts_.min_score);
    }

private:
    struct BuildJob {
        std::vector<std::string> passages;
        CacheLoad load;
        CacheStore store;
        std::size_t next{0};
        bool cache_tried{false};
        std::unique_ptr<DenseIndex> partial;
        std::string fp;
    };

    // ---- cache (mu_ held) ----
    std::shared_ptr<const std::vector<float>> cache_find(const std::string& key) {
        auto it = cache_.find(key);
        if (it == cache_.end()) return nullptr;
        lru_.splice(lru_.begin(), lru_, it->second.second);
        return it->second.first;
    }
    void cache_put(const std::string& key, std::shared_ptr<const std::vector<float>> v) {
        auto it = cache_.find(key);
        if (it != cache_.end()) {
            it->second.first = std::move(v);
            lru_.splice(lru_.begin(), lru_, it->second.second);
            return;
        }
        lru_.push_front(key);
        cache_.emplace(key, std::make_pair(std::move(v), lru_.begin()));
        while (cache_.size() > std::max<std::size_t>(1, opts_.cache_size)) {
            cache_.erase(lru_.back());
            lru_.pop_back();
        }
    }
    // Newest question first; stale partial questions are dropped.
    void enqueue(std::string key) {
        auto it = std::find(pending_.begin(), pending_.end(), key);
        if (it != pending_.end()) pending_.erase(it);
        pending_.push_front(std::move(key));
        while (pending_.size() > 3) pending_.pop_back();
    }

    void run() {
        std::vector<float> v;
        if (opts_.warm_up && embedder_) embedder_->embed("warm up", true, v);
        std::unique_lock<std::mutex> lk(mu_);
        for (;;) {
            cv_work_.wait(lk, [&] { return stop_ || !pending_.empty() || build_; });
            if (stop_) return;
            if (!pending_.empty()) {
                std::string key = std::move(pending_.front());
                pending_.pop_front();
                if (cache_find(key)) continue;
                lk.unlock();
                const auto t0 = std::chrono::steady_clock::now();
                v.clear();
                const bool ok = embedder_ && embedder_->embed(key, true, v);
                const double ms =
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
                lk.lock();
                stats_.last_embed_ms = ms;
                if (ok) {
                    dense::l2_normalize(v);
                    cache_put(key, std::make_shared<const std::vector<float>>(v));
                }
                cv_done_.notify_all();
                continue;
            }
            // One step of the index build, then look for questions again.
            std::shared_ptr<BuildJob> job = build_;
            lk.unlock();
            const bool finished = build_step(*job);
            lk.lock();
            if (build_ != job) continue; // replaced meanwhile
            if (finished) {
                if (job->partial && job->partial->size() == job->passages.size()) {
                    index_ = std::shared_ptr<const DenseIndex>(std::move(job->partial));
                    stats_.index_ready = true;
                    stats_.indexed = index_->size();
                }
                build_.reset();
                cv_done_.notify_all();
            } else {
                stats_.indexed = job->partial ? job->partial->size() : 0;
            }
        }
    }

    // Returns true when the job is done (successfully or not).
    bool build_step(BuildJob& job) {
        if (!embedder_ || job.passages.empty()) return true;
        if (!job.cache_tried) {
            job.cache_tried = true;
            job.fp = dense::fingerprint(embedder_->model_id(), job.passages);
            if (job.load) {
                if (auto bytes = job.load(job.fp)) {
                    if (auto idx = DenseIndex::deserialize(*bytes, job.fp); idx && idx->size() == job.passages.size()) {
                        job.partial = std::make_unique<DenseIndex>(std::move(*idx));
                        std::lock_guard<std::mutex> lk(mu_);
                        stats_.loaded_from_cache = true;
                        return true;
                    }
                }
            }
            job.partial = std::make_unique<DenseIndex>(embedder_->dim());
        }
        std::vector<float> v;
        if (!embedder_->embed(job.passages[job.next], false, v)) {
            job.partial.reset(); // a broken model never publishes half an index
            return true;
        }
        dense::l2_normalize(v);
        if (!job.partial->add(v)) {
            job.partial.reset();
            return true;
        }
        if (++job.next < job.passages.size()) return false;
        if (job.store) job.store(job.fp, job.partial->serialize(job.fp));
        return true;
    }

    std::shared_ptr<IEmbedder> embedder_;
    Options opts_;
    mutable std::mutex mu_;
    std::condition_variable cv_work_;
    std::condition_variable cv_done_;
    bool stop_{false};
    std::deque<std::string> pending_;
    std::shared_ptr<BuildJob> build_;
    std::shared_ptr<const DenseIndex> index_;
    std::list<std::string> lru_;
    std::unordered_map<std::string, std::pair<std::shared_ptr<const std::vector<float>>, std::list<std::string>::iterator>> cache_;
    Stats stats_;
    std::thread worker_;
};

} // namespace rtai
