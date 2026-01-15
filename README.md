# Raw Manager

Raw Manager is a local-first web app for reviewing RAW files, rating, tagging, and inspecting metadata like GPS coordinates and camera ratings. It is built with a Rust backend and a lightweight single-page frontend.

## Features

- Browse folders and preview RAW files.
- Read camera ratings (EXIF/XMP) and GPS metadata.
- Add your own ratings and tags (stored in SQLite).
- Download original files.
- Create folders, move, and delete files.
- Configure the library root through environment variables.

## Run with Docker

1. Set `RAW_LIBRARY_PATH` (host path) and `RAW_MANAGER_LIBRARY_ROOT` (container path) in `.env` or your shell.
   Example `.env`:

```sh
RAW_LIBRARY_PATH=/path/to/photos
RAW_MANAGER_LIBRARY_ROOT=/library
```

2. Ensure the library volume is mounted read-write if you want to move/delete files.
3. Start the stack:

```sh
docker compose up --build
```

4. Open `http://localhost:1234`.

## Run locally (without Docker)

```sh
cargo run
```

Set `RAW_MANAGER_LIBRARY_ROOT` in your environment or `.env`, then open `http://localhost:1234`.

## Notes

- Preview extraction uses embedded JPEG previews inside RAW files. Some files may not expose previews; those will show a placeholder.
- Camera ratings are read from EXIF/XMP when available. Your own ratings and tags are stored in SQLite (`data/raw-manager.db`).
