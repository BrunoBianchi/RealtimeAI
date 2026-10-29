const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { getCompanySvgLogo, generateDynamicCompanySvg } = require('./company_logos');

/**
 * Common known domains dictionary for fast, high-confidence mapping.
 */
const KNOWN_DOMAINS = {
  accenture: 'accenture.com',
  tata: 'tcs.com',
  tataconsultancy: 'tcs.com',
  tataconsultancyservices: 'tcs.com',
  tcs: 'tcs.com',
  infosys: 'infosys.com',
  capgemini: 'capgemini.com',
  deloitte: 'deloitte.com',
  hcl: 'hcltech.com',
  hcltech: 'hcltech.com',
  wipro: 'wipro.com',
  wiprolimited: 'wipro.com',
  cognizant: 'cognizant.com',
  ltimindtree: 'ltimindtree.com',
  ey: 'ey.com',
  ernstandyoung: 'ey.com',
  ernstyoung: 'ey.com',
  mphasis: 'mphasis.com',
  techmahindra: 'techmahindra.com',
  cgi: 'cgi.com',
  cgiinc: 'cgi.com',
  epam: 'epam.com',
  epamsystems: 'epam.com',
  persistent: 'persistent.com',
  persistentsystems: 'persistent.com',
  coforge: 'coforge.com',
  nubank: 'nubank.com.br',
  google: 'google.com',
  microsoft: 'microsoft.com',
  amazon: 'amazon.com',
  apple: 'apple.com',
  meta: 'meta.com',
  netflix: 'netflix.com',
  uber: 'uber.com',
  spotify: 'spotify.com',
  stripe: 'stripe.com',
  salesforce: 'salesforce.com',
  oracle: 'oracle.com',
  ibm: 'ibm.com',
  mercadolivre: 'mercadolibre.com',
  itau: 'itau.com.br',
  ifood: 'ifood.com.br',
  meli: 'mercadolibre.com',
  bradesco: 'bradesco.com.br'
};

/**
 * Derives the most likely internet domain for a company name.
 */
function deriveDomainFromCompanyName(name) {
  if (!name) return 'company.com';
  const clean = name.trim().toLowerCase();

  // If already looks like a domain
  if (clean.includes('.') && !clean.includes(' ')) {
    return clean;
  }

  const normalized = clean.replace(/[^a-z0-9]/g, '');
  if (KNOWN_DOMAINS[normalized]) {
    return KNOWN_DOMAINS[normalized];
  }

  // Common suffixes to strip
  const stripped = clean
    .replace(/\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|group|services|technologies|solutions|bank|tecnologia)\b/gi, '')
    .trim()
    .replace(/[^a-z0-9]/g, '');

  if (KNOWN_DOMAINS[stripped]) {
    return KNOWN_DOMAINS[stripped];
  }

  return `${stripped || normalized || 'company'}.com`;
}

/**
 * Helper to download an image from a URL into a Buffer.
 */
function downloadImageBuffer(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadImageBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('image') && !contentType.includes('octet-stream')) {
          // Some services return HTML on 404
          return reject(new Error(`Invalid content-type: ${contentType}`));
        }

        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length < 100) {
            return reject(new Error('Downloaded buffer too small'));
          }
          resolve({ buffer, contentType });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Resolves or fetches the official logo for a company.
 * 1. Checks curated SVGs (Tata, Infosys, Capgemini, Accenture, etc.).
 * 2. Checks local disk cache in <appDataDir>/company_logos/<companyId>.png.
 * 3. Downloads from Clearbit or Google Favicon and caches locally.
 * 4. Falls back to clean dynamic SVG.
 */
async function resolveAndCacheCompanyLogo(appDataDir, companyName, companyDomain = '') {
  const cleanName = (companyName || 'Company').trim();
  const domain = companyDomain || deriveDomainFromCompanyName(cleanName);
  const compId = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'company';

  // 1. Check curated SVGs first
  const curatedSvg = getCompanySvgLogo(compId) || getCompanySvgLogo(cleanName);
  if (curatedSvg) {
    return {
      companyId: compId,
      name: cleanName,
      domain,
      logoUrl: `data:image/svg+xml;utf8,${encodeURIComponent(curatedSvg)}`,
      svg: curatedSvg,
      source: 'curated_vector'
    };
  }

  // 2. Check local disk cache
  const logosDir = path.join(appDataDir, 'company_logos');
  const localCachePath = path.join(logosDir, `${compId}.png`);

  if (fs.existsSync(localCachePath)) {
    try {
      const stat = fs.statSync(localCachePath);
      if (stat.size > 200) {
        const base64 = fs.readFileSync(localCachePath).toString('base64');
        return {
          companyId: compId,
          name: cleanName,
          domain,
          logoUrl: `data:image/png;base64,${base64}`,
          localPath: localCachePath,
          source: 'local_cache'
        };
      }
    } catch (_e) {}
  }

  // 3. Try live fetching from Clearbit and Google Favicon
  const candidateUrls = [
    `https://logo.clearbit.com/${domain}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://unavatar.io/${domain}`
  ];

  for (const url of candidateUrls) {
    try {
      const { buffer, contentType } = await downloadImageBuffer(url, 3500);
      fs.mkdirSync(logosDir, { recursive: true });
      fs.writeFileSync(localCachePath, buffer);

      const mime = contentType.includes('png') ? 'image/png' : 'image/jpeg';
      return {
        companyId: compId,
        name: cleanName,
        domain,
        logoUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        localPath: localCachePath,
        source: 'live_fetch'
      };
    } catch (_err) {
      // Continue to next provider
    }
  }

  // 4. Fallback to clean dynamic SVG
  const fallbackSvg = generateDynamicCompanySvg(cleanName);
  return {
    companyId: compId,
    name: cleanName,
    domain,
    logoUrl: `data:image/svg+xml;utf8,${encodeURIComponent(fallbackSvg)}`,
    svg: fallbackSvg,
    source: 'dynamic_svg'
  };
}

module.exports = {
  deriveDomainFromCompanyName,
  resolveAndCacheCompanyLogo,
  downloadImageBuffer,
  KNOWN_DOMAINS
};
