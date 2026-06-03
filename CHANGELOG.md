# Changelog

## [0.2.1](https://github.com/duongdev/cdp-browser/compare/cdp-browser-v0.2.0...cdp-browser-v0.2.1) (2026-06-03)


### Features

* **notifications:** capture slack notifications with per-workspace grouping (t064) ([6ef97ab](https://github.com/duongdev/cdp-browser/commit/6ef97ab))

## [0.2.0](https://github.com/duongdev/cdp-browser/compare/cdp-browser-v0.1.0...cdp-browser-v0.2.0) (2026-06-01)


### Features

* **local-tabs:** add local tabs alongside cdp screencast tabs (t005) ([a333ce3](https://github.com/duongdev/cdp-browser/commit/a333ce3528f7852468997ae3965ac48adb18a129))
* **notifications:** add outlook adapter and read controls (t002) ([11936b4](https://github.com/duongdev/cdp-browser/commit/11936b4c620200e005babb97b75bd45f940d958b))
* **notifications:** capture teams toasts via cdp side-channel with bell, badges, and os alerts ([f53f4cc](https://github.com/duongdev/cdp-browser/commit/f53f4ccb4351e69bd03498a175330dd6a3cd890f))
* **notifications:** deep-open teams chat from notification click ([b047bb8](https://github.com/duongdev/cdp-browser/commit/b047bb8dac83905fd25e545d8b2369d05668aeca))
* **notifications:** group popover by thread and mark whole thread read on open ([c2c658c](https://github.com/duongdev/cdp-browser/commit/c2c658c656f0f3b1ecb0e437d607aca6f95ac29a))
* **pins:** hold live tabs arc-style (t004) ([602dc07](https://github.com/duongdev/cdp-browser/commit/602dc076ac6d90ad0631bea6e65e38dd79bb1a62))
* **settings:** non-modal drawer with adaptive auto-recover and crash-safe overrides ([fd5e0ee](https://github.com/duongdev/cdp-browser/commit/fd5e0eeacbc98e5a292cab4ac20512cd87f91efb))
* **theme:** sync remote page prefers-color-scheme with app theme ([a5d1b05](https://github.com/duongdev/cdp-browser/commit/a5d1b056242ac55f72f9627b8acb14242b37c8f6))
* **ui:** resizable sidebar, bottom status bar, and persisted ui state ([3378656](https://github.com/duongdev/cdp-browser/commit/3378656181108b476cdbb1dd2fea1bd600da58fe))
* v0.1.0 production polish (web pwa, ipad, latency, find, palette) ([b0656fa](https://github.com/duongdev/cdp-browser/commit/b0656fac9a4096626e2d0ce81481503ce8b71dec))
* **viewport:** adaptive viewport sizing with host-resize back-off and tab-switch blur ([c56e28a](https://github.com/duongdev/cdp-browser/commit/c56e28aa21f9c4371b9f608fce310efefa29dc33))
* **web:** add browser web build with sse+post proxy and docker deploy (t006-t010) ([16e6015](https://github.com/duongdev/cdp-browser/commit/16e6015d9b8cf2c290381f6d2d902a812c924fe0))
* **web:** add pwa, push toggle, streaming input and e2e encryption (t011-t012) ([ab483c2](https://github.com/duongdev/cdp-browser/commit/ab483c2aa42e14a4893817c6c0dcaba6c45569b4))
* **web:** ipad pwa port with vapid web push (t015-t017) ([fd8f599](https://github.com/duongdev/cdp-browser/commit/fd8f59984201effa0c4e94b548ecc9058fbd678a))
* **web:** websocket transport + connection-mode picker + perf hardening (t019) ([cddfece](https://github.com/duongdev/cdp-browser/commit/cddfece8ddcaeacc68d4b8af93bf9ed6a4508a76))


### Bug Fixes

* **build:** bundle notifications.js and inject/ into packaged asar ([5fde5d9](https://github.com/duongdev/cdp-browser/commit/5fde5d92e953206b155df3f5f8740160b6a2a3b4))
* **input:** stop forwarding macos-reserved shortcuts to remote page ([1c64114](https://github.com/duongdev/cdp-browser/commit/1c6411450caf41dfd1983254b22b7db07c0c588f))
* **notifications:** dedup teams toasts per message not per thread ([1a099fa](https://github.com/duongdev/cdp-browser/commit/1a099faf53a381f5849d925ff24e498c26e2e33e))
* **notifications:** retain electron notification objects so click events fire ([6e1cceb](https://github.com/duongdev/cdp-browser/commit/6e1ccebb9a921fdc09eb4d6cf3df0065618f63b2))
* **remote-page:** track main frame so subframe loads don't pin the loading bar ([d8ff93b](https://github.com/duongdev/cdp-browser/commit/d8ff93bfa24b2a2212d6e55dbe4dab63743acc12))
* **web:** copy crypto-envelope and line-splitter into docker image ([687e06e](https://github.com/duongdev/cdp-browser/commit/687e06e01a6ed9b6af87c72251bc2de5987a4f88))
* **web:** event-driven mouse input and correct downscaled-frame coordinates (t013-t014) ([e13ee07](https://github.com/duongdev/cdp-browser/commit/e13ee079123570b8d78f36ac36b7ed4ff8ebc88f))
* **web:** forward e2e env vars through docker compose ([61af8bd](https://github.com/duongdev/cdp-browser/commit/61af8bdb347c2e60e05e43ee4e56c992e33b6f20))
* **web:** restore 100vh fallback before 100dvh override ([4a24997](https://github.com/duongdev/cdp-browser/commit/4a249970a225822ad99184de762aa7e03c28b32a))
* **web:** scope ipad safe-area to chrome, not root padding ([f1a063d](https://github.com/duongdev/cdp-browser/commit/f1a063d824001af50ddc1ba72d36f8632919617a))
* **web:** use named websocketserver import (esm) ([da548e1](https://github.com/duongdev/cdp-browser/commit/da548e1defb96278d6adf4348411ab7f3d019fa5))
