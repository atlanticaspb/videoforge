# VideoForge Backend

Node.js backend for VideoForge — media library indexing, project management, and video editing API.

## Setup

```bash
cd backend
cp config/.env.example config/.env
npm install
```

## Usage

Index media files:
```bash
npm run index:media
# or specify a directory:
node scripts/indexMedia.js /path/to/media
```

Start dev server:
```bash
npm run dev
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/media` | List media (query: `type`, `search`, `limit`, `offset`) |
| GET | `/api/media/:id` | Get single media |
| POST | `/api/media/index` | Index a file by path |
| DELETE | `/api/media/:id` | Delete media record |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project with timeline |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/timeline` | Add media to timeline |
| DELETE | `/api/projects/:id/timeline/:entryId` | Remove from timeline |
