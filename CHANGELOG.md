# Changelog

## [2.1.0](https://github.com/BrunoBianchi/RealtimeAI/compare/v2.0.0...v2.1.0) (2026-10-29)


### Novidades

* **app:** embed the build version in the native overlay ([0165aa2](https://github.com/BrunoBianchi/RealtimeAI/commit/0165aa22db32e6f86323733c7fff432c910de73f))
* **dashboard:** add session metrics, live input meter and floating meeting popup ([63a6367](https://github.com/BrunoBianchi/RealtimeAI/commit/63a6367b97c1a5450fb8c0f97331954c5be5e1f4))
* **dashboard:** apply RealTimeAI Executive design system and settings layout ([78db47d](https://github.com/BrunoBianchi/RealtimeAI/commit/78db47d61b799f4510897d5298e9a89d8f6ca512))
* **dashboard:** redesign session studio UI, add JEV question bank and fix Windows launchers ([0bd9f3a](https://github.com/BrunoBianchi/RealtimeAI/commit/0bd9f3a5ec7becf8e1b783d2b9289db4f4a3be7b))
* **dashboard:** responsive Executive UI, live STAR scores and modals ([9af703e](https://github.com/BrunoBianchi/RealtimeAI/commit/9af703e1d6cacd7f80da864e016e29d5ed77c3c6))
* minimal UI, real auto-update and feature flags ([73415b4](https://github.com/BrunoBianchi/RealtimeAI/commit/73415b4bb383cde92111e4e715ae664b9669d88a))
* **rag:** add hybrid BM25 + dense retrieval with local e5 embeddings ([c74ba44](https://github.com/BrunoBianchi/RealtimeAI/commit/c74ba441773bb7206b12201244aec48859be908b))
* **scripts:** add a test build launcher and a local installer ([30fb34c](https://github.com/BrunoBianchi/RealtimeAI/commit/30fb34cc965c41039ad059eae4ea4754630a8f0f))


### Correções

* **dashboard:** grant device permissions only to the bundled UI ([a01e2b3](https://github.com/BrunoBianchi/RealtimeAI/commit/a01e2b31eb27b04a31bbf53ed2196586c86d6e77))
* **dashboard:** improve responsive layout and fix sidebar plan button alignment ([a883406](https://github.com/BrunoBianchi/RealtimeAI/commit/a8834069eb6c741de121f7c798c2bb2c440393c1))
* **llm:** fail over only to providers that have an API key ([eaf0c11](https://github.com/BrunoBianchi/RealtimeAI/commit/eaf0c11994958ac5bf9c89b1f6958c2aec60500c))
* **updater:** look for updates in this repository by default ([f7486be](https://github.com/BrunoBianchi/RealtimeAI/commit/f7486be05cbcc5be240292039f2049954cf0d87c))


### Desempenho

* **app:** run with 1 ms timers and without EcoQoS throttling ([1352405](https://github.com/BrunoBianchi/RealtimeAI/commit/13524056b065ee3717d73421a9d0dc3ac45641e8))
* **dashboard:** stop blocking the main process on child processes ([efacb78](https://github.com/BrunoBianchi/RealtimeAI/commit/efacb78ee29075f54a3008002187dfbe087e65c2))
* **engine:** wake the orchestrator at the exact timer deadline ([414f0e7](https://github.com/BrunoBianchi/RealtimeAI/commit/414f0e79ab7052dfdfb883c95410c1fe3482472b))
* **llm:** faster cold connects and warm fallback providers ([2fead1c](https://github.com/BrunoBianchi/RealtimeAI/commit/2fead1c8042b8be1d96fcda498e18ae47edbc579))
