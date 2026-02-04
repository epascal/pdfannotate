# PDFAnnotate

A web application for **offline-first PDF annotation** with automatic synchronization.

## Features

- **Offline-first**: Works completely offline, syncs when online
- **PDF.js viewer**: Full-featured PDF viewing with Mozilla's PDF.js
- **Annotations**: Highlight, comment, and annotate PDFs
- **Auto-sync**: Changes are automatically synchronized to the server
- **Stable URLs**: Share documents via permanent URLs
- **PWA**: Installable as a Progressive Web App
- **Conflict resolution**: Smart handling of concurrent edits

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (PWA)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   React     │  │  IndexedDB  │  │     PDF.js          │  │
│  │   Router    │  │  (offline)  │  │     Viewer          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ REST API
┌─────────────────────────────────────────────────────────────┐
│                        Backend                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Express   │  │   SQLite    │  │   File Storage      │  │
│  │   Server    │  │   Index     │  │   (PDF revisions)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

**Frontend:**
- React 19 + TypeScript
- Vite + vite-plugin-pwa
- PDF.js (Mozilla)
- IndexedDB (idb)
- React Router

**Backend:**
- Node.js + Express
- SQLite (sql.js)
- TypeScript

## Getting Started

### Prerequisites

- Node.js 20+ recommended
- npm 10+

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pdfannotate.git
cd pdfannotate

# Install dependencies
npm install
```

### Development

```bash
npm run dev
```

This starts both frontend and backend in development mode:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

### Production Build

```bash
# Build both frontend and backend
npm run build

# Start production server
npm run start
```

Open http://localhost:3001

## Usage

1. **Drop a PDF** on the home page to create a new document
2. **Annotate** using PDF.js tools (highlight, comment, etc.)
3. **Save** with Ctrl+S - changes are saved locally immediately
4. **Share** the stable URL (`/d/:docId`) to access from anywhere
5. **Sync** happens automatically when online

### Offline Mode

- Documents are stored in IndexedDB
- All annotations work offline
- Changes queue in an "outbox" and sync when online
- Conflict detection prompts you to choose which version to keep

## Project Structure

```
pdfannotate/
├── frontend/           # React PWA
│   ├── src/
│   │   ├── App.tsx     # Main application
│   │   ├── db.ts       # IndexedDB operations
│   │   └── sync.ts     # Sync logic
│   ├── public/
│   │   └── pdfjs/      # PDF.js assets (auto-downloaded)
│   └── scripts/
│       └── copy-pdfjs.mjs  # PDF.js setup script
├── backend/            # Express server
│   └── src/
│       ├── index.ts    # API routes
│       └── indexDb.ts  # SQLite operations
└── package.json        # Monorepo root
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/docs/:docId/meta` | Get document metadata |
| GET | `/api/docs/:docId/file` | Download PDF file |
| POST | `/api/docs` | Create new document |
| PUT | `/api/docs/:docId` | Update document |
| GET | `/api/health` | Health check |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development servers |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |

## License

MIT - see [LICENSE](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
