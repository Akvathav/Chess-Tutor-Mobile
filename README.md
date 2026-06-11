# Chess Coach Mobile — Offline PWA

A completely standalone, offline chess training app powered by **Stockfish WASM** (no Python, no internet required).

## File Structure

```
CHESS TUTOR MOBILE/
├── game.html          # Main app (standalone, no Flask)
├── game.js            # Full offline game logic (WASM-powered)
├── style.css          # Mobile-first CSS
├── engineWorker.js    # Stockfish Web Worker (off UI thread)
├── sw.js              # Service Worker (offline caching)
├── manifest.json      # PWA manifest (standalone, portrait)
├── serve.ps1          # Local test server script
├── lib/
│   ├── stockfish.js   # Stockfish WASM loader
│   ├── stockfish.wasm # Compiled Stockfish engine
│   ├── chess.min.js   # chess.js (game logic)
│   ├── chessboard-1.0.0.min.js
│   ├── chessboard-1.0.0.min.css
│   └── jquery-3.7.1.min.js
├── img/chesspieces/wikipedia/  # Chess piece images
└── sounds/            # Move sound effects
```

## How to Run Locally (for Testing)

> ⚠️ The app **must** be served over HTTP (not opened as a file://) because:
> - Service Workers require HTTP
> - Web Workers may have restrictions as file://

### Option A — Python (if installed)
```powershell
python -m http.server 8080
# Then open: http://localhost:8080/game.html
```

### Option B — Node.js serve script
```powershell
.\serve.ps1
# Then open: http://localhost:8080/game.html
```

### Option C — VS Code Live Server
Install the "Live Server" extension in VS Code, then right-click `game.html` → **Open with Live Server**.

## Compiling to Android APK

### Method 1: PWA Builder (Recommended — Free)
1. Deploy this folder to any static host (GitHub Pages, Netlify, etc.)
2. Visit https://www.pwabuilder.com/
3. Paste your URL → Generate Android Package
4. Download and install the `.apk`

### Method 2: Capacitor (for full native app)
```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Chess Coach" com.chesscoachmobile.app --web-dir .
npx cap add android
npx cap sync
npx cap open android
# Then build APK in Android Studio
```

## Architecture

| Feature | Desktop (Flask) | Mobile (WASM) |
|---------|----------------|---------------|
| Engine  | Stockfish binary via subprocess | Stockfish.js (WASM) via Web Worker |
| Move API | `fetch('/api/move')` | Direct Worker messages |
| ELO Calc | Python math | Pure JS: `max(600, min(2400, 2500 - avgCpl*10 + 100*wins - 50*losses))` |
| Beginner Crush | Python logic | JS MultiPV: 25% chance to play 2nd/3rd best if eval > +3.0 |
| Commentary | Ollama LLM | Local text generation (CPL-based) |
| Database | SQLite | localStorage |
| Offline | ❌ | ✅ Service Worker + aggressive caching |

## Touch Support

- Chessboard.js natively handles `touchstart`/`touchmove` for piece dragging on Android/iOS
- All buttons are minimum **48px** height (Material Design touch target)
- Viewport meta disables pinch-to-zoom for a native-app feel
- Layout stacks vertically: Board → Controls → Coach Panel
