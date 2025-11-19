# Performance Optimization Guide - Imani Wallet

**Document Version:** 1.0.0
**Last Updated:** 2025-11-19
**Target:** Phase 3, Task 3.2
**Goal:** Lighthouse Score ≥90, Bundle Size <500KB

## Overview

This document outlines all performance optimizations implemented for Imani Wallet Web,
including bundle optimization, lazy loading, PWA support, and perceived performance improvements.

---

## Bundle Size Optimization

### Current Status

**Before Optimization:**
- Bundle Size: 2.48 MiB (2,601,984 bytes)
- Entry Point: imani-wallet.js
- Target: <500KB (512,000 bytes)
- **Reduction Needed:** ~80%

### Webpack Optimizations Implemented

#### 1. Code Splitting

**File:** `imani-web/webpack.config.d/optimization.js`

Configured Webpack to split vendor code into separate chunks:

```javascript
splitChunks: {
    chunks: 'all',
    cacheGroups: {
        kotlinStdlib: {
            test: /[\\/]node_modules[\\/]kotlin/,
            name: 'kotlin-stdlib',
            priority: 30
        },
        compose: {
            test: /[\\/]node_modules[\\/]@jetbrains[\\/]compose/,
            name: 'compose-runtime',
            priority: 20
        },
        vendors: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            priority: 10
        }
    }
}
```

**Benefits:**
- Better caching (vendor code changes less frequently)
- Parallel downloads
- Faster incremental updates

#### 2. Production Optimizations

```javascript
// Tree shaking
usedExports: true
sideEffects: true

// Module concatenation
concatenateModules: true

// Deterministic IDs for caching
moduleIds: 'deterministic'
chunkIds: 'deterministic'
```

#### 3. Build Configuration

**File:** `imani-web/build.gradle.kts`

```kotlin
js(IR) {
    browser {
        commonWebpackConfig {
            outputFileName = "imani-wallet.js"
        }
    }
    binaries.executable()
}
```

### Additional Bundle Optimizations

#### Phase 4 Recommendations:

1. **Dynamic Imports** for route-based code splitting
2. **Tree Shaking** verification (remove unused Compose components)
3. **Dependency Analysis** (identify large dependencies)
4. **Image Optimization** (compress icons, use WebP)
5. **Remove Development Tools** from production bundles

---

## Progressive Web App (PWA)

### Service Worker

**File:** `imani-web/src/jsMain/resources/service-worker.js`

**Caching Strategy:**
- **Static Assets:** Cache-first (HTML, JS, CSS, WASM)
- **API Calls:** Network-first (with cache fallback)
- **Runtime Cache:** Separate cache for dynamic content

**Features:**
- Offline support
- Cache versioning
- Update notifications
- Automatic cache cleanup

**Cache Configuration:**
```javascript
const CACHE_NAME = 'imani-wallet-v1.0.0';
const RUNTIME_CACHE = 'imani-wallet-runtime-v1';

const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/imani-wallet.js',
    '/skiko.wasm'
];
```

### Web App Manifest

**File:** `imani-web/src/jsMain/resources/manifest.json`

**PWA Features:**
- Installable app
- Standalone display mode
- App shortcuts (Issue Voucher, Redeem Voucher)
- Brand colors (#6B46C1 - Deep Purple, #FFFBEB - Cream)
- Multiple icon sizes (72px - 512px)
- Screenshots for app stores

**Manifest Configuration:**
```json
{
  "name": "Imani Wallet",
  "short_name": "Imani",
  "display": "standalone",
  "theme_color": "#6B46C1",
  "background_color": "#FFFBEB"
}
```

---

## Perceived Performance

### Loading Skeletons

**File:** `imani-app/src/commonMain/kotlin/cash/imani/app/ui/components/LoadingSkeleton.kt`

**Components:**
- `SkeletonBox`: Generic shimmer skeleton
- `IdentityListItemSkeleton`: Identity list loading state
- `VoucherListItemSkeleton`: Voucher list loading state
- `ListLoadingSkeleton`: Full-screen loading with multiple items

**Shimmer Effect:**
- Animated gradient sweep
- 1.2s animation duration
- Subtle gray colors
- Infinite loop

**Usage Example:**
```kotlin
when (state) {
    is Loading -> ListLoadingSkeleton(itemCount = 3) {
        IdentityListItemSkeleton()
    }
    is Success -> IdentityList(identities)
}
```

### Initial Load Spinner

**File:** `imani-web/src/jsMain/resources/index.html`

**Features:**
- CSS-only spinner (no JavaScript required)
- Brand colors (#6B46C1)
- Centered loading message
- Automatic removal on app load

**Implementation:**
```html
<div id="app-loading">
    <div class="spinner"></div>
    <p>Loading Imani Wallet...</p>
</div>
```

---

## HTML Optimizations

### Meta Tags

**Performance:**
```html
<!-- Preconnect to external domains -->
<link rel="preconnect" href="https://testnut.cashu.space">
<link rel="dns-prefetch" href="https://testnut.cashu.space">
```

**PWA Support:**
```html
<!-- Web App Manifest -->
<link rel="manifest" href="/manifest.json">

<!-- Theme Colors -->
<meta name="theme-color" content="#6B46C1">

<!-- iOS PWA Support -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Imani">
```

**SEO:**
```html
<title>Imani Wallet - Built on Trust, Secured by Math</title>
<meta name="description" content="Self-custody digital voucher wallet...">
```

---

## Lighthouse Audit Checklist

### Performance (Target: ≥90)

- [x] **Minimize main thread work**
  - Code splitting configured
  - Webpack optimization enabled

- [x] **Optimize JavaScript bundles**
  - Tree shaking enabled
  - Module concatenation enabled
  - Production build configured

- [x] **Reduce render-blocking resources**
  - Inline critical CSS
  - Preconnect to external domains

- [x] **Implement lazy loading**
  - Service worker for offline caching
  - Loading skeletons for perceived performance

- [ ] **Image optimization** (Phase 4)
  - Compress app icons
  - Use WebP format
  - Responsive images

- [ ] **Font optimization** (Phase 4)
  - Subset fonts
  - Preload critical fonts

### Accessibility (Target: ≥90)

- [x] **Color contrast** (Brand colors meet WCAG AA)
- [x] **Meta viewport** configured
- [ ] **ARIA labels** (Phase 4 - add to all interactive elements)
- [ ] **Keyboard navigation** (Phase 4 - ensure full keyboard support)

### Best Practices (Target: ≥90)

- [x] **HTTPS** (CSP configured, deployment guide provided)
- [x] **No console errors**
- [x] **Secure cookies** (No cookies used - localStorage only)
- [x] **CSP headers** (Configured in index.html)

### SEO (Target: ≥90)

- [x] **Valid meta tags**
- [x] **Descriptive title**
- [x] **Meta description**
- [x] **Viewport meta tag**
- [ ] **Structured data** (Phase 4 - add JSON-LD)
- [ ] **Sitemap.xml** (Phase 4)
- [ ] **Robots.txt** (Phase 4)

### PWA (Target: Installable)

- [x] **Web App Manifest** (manifest.json)
- [x] **Service Worker** (Offline support)
- [x] **HTTPS** (Required for PWA)
- [x] **Icons** (Multiple sizes configured)
- [ ] **Screenshots** (Phase 4 - add real screenshots)
- [ ] **Install prompt** (Phase 4 - custom install UI)

---

## Testing & Monitoring

### Lighthouse Audit

**Command:**
```bash
# Install Lighthouse CLI
npm install -g lighthouse

# Run audit
lighthouse https://your-domain.com --output html --output-path ./lighthouse-report.html

# Or use Chrome DevTools:
# 1. Open DevTools (F12)
# 2. Navigate to "Lighthouse" tab
# 3. Click "Generate report"
```

**Target Scores:**
- Performance: ≥90
- Accessibility: ≥90
- Best Practices: ≥90
- SEO: ≥90
- PWA: Installable

### Bundle Analysis

**Webpack Bundle Analyzer:**

1. Add to `build.gradle.kts`:
```kotlin
// TODO: Add webpack bundle analyzer plugin
```

2. Run:
```bash
./gradlew :imani-web:jsBrowserProductionWebpack --info
```

3. Analyze output in `build/distributions/`

### Performance Monitoring

**Tools:**
- **Lighthouse CI**: Automated Lighthouse audits in CI/CD
- **WebPageTest**: Real-world performance testing
- **Chrome DevTools Performance**: Runtime performance profiling
- **Network Tab**: Bundle size verification

---

## Deployment Optimizations

### Production Build

```bash
# Build for production
./gradlew :imani-web:jsBrowserProductionWebpack

# Output location
build/dist/js/productionExecutable/
```

### Server Configuration

**Nginx Example:**
```nginx
# Gzip compression
gzip on;
gzip_types text/css application/javascript image/svg+xml;
gzip_min_length 1024;

# Cache control
location ~* \.(js|css|wasm|png|jpg|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# Service worker (no cache)
location = /service-worker.js {
    expires off;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}
```

### CDN Configuration

**Recommendations:**
- Use CDN for static assets
- Enable HTTP/2 or HTTP/3
- Configure proper cache headers
- Enable Brotli compression

---

## Performance Budget

| Resource | Budget | Current | Status |
|----------|--------|---------|--------|
| **Total Bundle Size** | <500KB | 2.48MB | ❌ OVER |
| **JavaScript** | <400KB | ~2.4MB | ❌ OVER |
| **CSS** | <50KB | Inline | ✅ OK |
| **Images** | <100KB | TBD | ⚠️ PENDING |
| **Fonts** | <50KB | System | ✅ OK |
| **Total Page Size** | <1MB | TBD | ⚠️ PENDING |

**Note:** Bundle size is currently over budget. Phase 4 optimizations required.

---

## Next Steps (Phase 4)

### Critical Optimizations

1. **Bundle Size Reduction**
   - Implement route-based code splitting
   - Analyze and remove unused dependencies
   - Optimize Compose components

2. **Image Optimization**
   - Add app icons (WebP format)
   - Compress existing images
   - Implement responsive images

3. **Lazy Loading**
   - Lazy load screens/routes
   - Lazy load heavy components
   - Implement intersection observer for lists

### Nice-to-Have Optimizations

4. **Font Optimization**
   - Subset system fonts if custom fonts added
   - Preload critical fonts

5. **Advanced Caching**
   - Implement IndexedDB caching for vouchers
   - Add background sync for offline actions

6. **Performance Monitoring**
   - Set up Lighthouse CI
   - Add real user monitoring (RUM)
   - Track Web Vitals (LCP, FID, CLS)

---

## Benchmarks

### Target Metrics (Phase 3)

| Metric | Target | Current | Phase 4 Goal |
|--------|--------|---------|--------------|
| **First Contentful Paint (FCP)** | <1.8s | TBD | <1.0s |
| **Largest Contentful Paint (LCP)** | <2.5s | TBD | <2.0s |
| **Time to Interactive (TTI)** | <3.8s | TBD | <3.0s |
| **Total Blocking Time (TBT)** | <200ms | TBD | <150ms |
| **Cumulative Layout Shift (CLS)** | <0.1 | TBD | <0.05 |

### Real-World Testing

**Test Conditions:**
- **Network:** 3G, 4G, WiFi
- **Devices:** Desktop, Mobile, Tablet
- **Browsers:** Chrome, Firefox, Safari, Edge

---

## References

- [Lighthouse Documentation](https://developer.chrome.com/docs/lighthouse/)
- [Web.dev Performance](https://web.dev/performance/)
- [PWA Checklist](https://web.dev/pwa-checklist/)
- [Webpack Optimization](https://webpack.js.org/guides/production/)
- [Kotlin/JS Performance](https://kotlinlang.org/docs/js-ir-compiler.html)

---

## Maintenance

**Regular Tasks:**
- Update service worker version on each release
- Run Lighthouse audits before each deployment
- Monitor bundle size with each dependency addition
- Review and update performance budget quarterly
- Test PWA installation on multiple devices

**Version History:**
- v1.0.0 (2025-11-19): Initial performance optimization implementation
