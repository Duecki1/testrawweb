# Raw Manager

Raw Manager is a local-first web app for reviewing RAW files, rating, tagging, and inspecting metadata like GPS coordinates and camera ratings. It is built with a Rust backend and a lightweight single-page frontend.

## Features

- Browse folders and preview RAW files.
- Read camera ratings (EXIF/XMP) and GPS metadata.
- Add your own ratings and tags (stored in SQLite).
- Download original files.
- First-run setup flow to pick the library root.

## Run with Docker

1. Set `RAW_LIBRARY_PATH` (host path) or place files under `./photos` next to the compose file.
2. Start the stack:

```sh
docker compose up --build
```

3. Open `http://localhost:8080` and complete the setup. If you used the compose example, choose `/library` as the library root.

## Run locally (without Docker)

```sh
cargo run
```

Open `http://localhost:8080` and complete the setup.

## Notes

- Preview extraction uses embedded JPEG previews inside RAW files. Some files may not expose previews; those will show a placeholder.
- Camera ratings are read from EXIF/XMP when available. Your own ratings and tags are stored in SQLite (`data/raw-manager.db`).
