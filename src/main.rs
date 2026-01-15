mod db;
mod metadata;

use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use db::FileMeta;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    library_root: Arc<RwLock<Option<PathBuf>>>,
    library_root_canon: Arc<RwLock<Option<PathBuf>>>,
    preview_dir: PathBuf,
}

#[derive(Debug, Serialize)]
struct ConfigResponse {
    configured: bool,
    library_root: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

#[derive(Debug, Serialize)]
struct BrowseResponse {
    path: String,
    entries: Vec<BrowseEntry>,
}

#[derive(Debug, Serialize)]
struct BrowseEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<i64>,
    modified: Option<i64>,
    camera_rating: Option<i32>,
    user_rating: Option<i32>,
    tags: Vec<String>,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    taken_at: Option<String>,
    orientation: Option<i32>,
    needs_scan: bool,
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Debug, Deserialize)]
struct PreviewQuery {
    path: String,
    kind: Option<String>,
}

#[derive(Debug, Serialize)]
struct FileMetaResponse {
    path: String,
    name: String,
    camera_rating: Option<i32>,
    user_rating: Option<i32>,
    tags: Vec<String>,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    taken_at: Option<String>,
    orientation: Option<i32>,
    file_size: i64,
    last_modified: i64,
}

#[derive(Debug, Deserialize)]
struct RatingRequest {
    path: String,
    rating: Option<i32>,
}

#[derive(Debug, Serialize)]
struct RatingResponse {
    user_rating: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct TagsRequest {
    path: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TagsResponse {
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TagsListResponse {
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MkdirRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
struct DeleteRequest {
    paths: Vec<String>,
    recursive: bool,
}

#[derive(Debug, Deserialize)]
struct MoveRequest {
    paths: Vec<String>,
    destination: String,
}

#[derive(Debug, Serialize)]
struct FsResponse {
    success: bool,
}

#[derive(Debug, Deserialize)]
struct UploadQuery {
    path: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(ErrorResponse {
            error: self.message,
        });
        (self.status, body).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "raw_manager=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    dotenvy::dotenv().ok();

    let data_dir = env::var("RAW_MANAGER_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    let data_dir = PathBuf::from(data_dir);
    tokio::fs::create_dir_all(&data_dir).await?;
    let preview_dir = data_dir.join("previews");
    tokio::fs::create_dir_all(&preview_dir).await?;

    let db_path = data_dir.join("raw-manager.db");
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options).await?;
    db::init_db(&pool).await?;

    let configured_root = read_library_root_env();
    let (library_root, library_root_canon) = if let Some(root) = configured_root.clone() {
        let root_path = PathBuf::from(&root);
        match tokio::fs::canonicalize(&root_path).await {
            Ok(canon) => (Some(root_path), Some(canon)),
            Err(err) => {
                error!("Failed to canonicalize configured root: {err}");
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    let state = AppState {
        pool,
        library_root: Arc::new(RwLock::new(library_root)),
        library_root_canon: Arc::new(RwLock::new(library_root_canon)),
        preview_dir,
    };

    let api = Router::new()
        .route("/config", get(get_config))
        .route("/browse", get(browse))
        .route("/file/metadata", get(file_metadata))
        .route("/file/preview", get(file_preview))
        .route("/file/download", get(file_download))
        .route("/file/rating", post(set_rating))
        .route("/file/tags", post(set_tags))
        .route("/tags", get(list_tags))
        .route("/fs/mkdir", post(fs_mkdir))
        .route("/fs/delete", post(fs_delete))
        .route("/fs/move", post(fs_move))
        .route("/fs/upload", post(fs_upload))
        .route("/health", get(health));

    let static_service = ServeDir::new("static").fallback(ServeFile::new("static/index.html"));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = env::var("RAW_MANAGER_ADDR").unwrap_or_else(|_| "0.0.0.0:1234".to_string());
    info!("Raw Manager listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

async fn get_config(State(state): State<AppState>) -> ApiResult<Json<ConfigResponse>> {
    let root = state.library_root.read().await;
    let value = root.as_ref().and_then(|path| path.to_str().map(|s| s.to_string()));
    Ok(Json(ConfigResponse {
        configured: value.is_some(),
        library_root: value,
    }))
}

async fn browse(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> ApiResult<Json<BrowseResponse>> {
    let rel_path = query.path.unwrap_or_default();
    let root_canon = get_root_canon(&state).await?;

    let rel = sanitize_relative(&rel_path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Path not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&full_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Folder not found"))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Read error"))?
    {
        let path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let file_type = entry
            .file_type()
            .await
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Read error"))?;

        if file_type.is_dir() {
            let rel = path
                .strip_prefix(&root_canon)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            entries.push(BrowseEntry {
                name,
                path: rel,
                kind: "dir".to_string(),
                size: None,
                modified: None,
                camera_rating: None,
                user_rating: None,
                tags: Vec::new(),
                gps_lat: None,
                gps_lon: None,
                taken_at: None,
                orientation: None,
                needs_scan: false,
            });
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        if !is_supported_raw(&path) {
            continue;
        }

        let rel = path
            .strip_prefix(&root_canon)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let meta = entry.metadata().await.ok();
        let (size, modified) = if let Some(meta) = meta {
            let size = meta.len() as i64;
            let modified = to_unix_seconds(meta.modified().ok());
            (size, modified)
        } else {
            (0, 0)
        };

        let db_meta = db::get_file_meta(&state.pool, &rel)
            .await
            .map_err(internal_error)?;

        let (camera_rating, user_rating, tags, gps_lat, gps_lon, taken_at, orientation, needs_scan) =
            match db_meta {
                Some(db_meta) => {
                    let is_fresh = db_meta.file_size == size
                        && db_meta.last_modified == modified
                        && db_meta.orientation.is_some();
                    (
                        db_meta.camera_rating,
                        db_meta.user_rating,
                        db_meta.tags,
                        db_meta.gps_lat,
                        db_meta.gps_lon,
                        db_meta.taken_at,
                        db_meta.orientation,
                        !is_fresh,
                    )
                }
                None => (None, None, Vec::new(), None, None, None, None, true),
            };

        entries.push(BrowseEntry {
            name,
            path: rel,
            kind: "file".to_string(),
            size: Some(size),
            modified: Some(modified),
            camera_rating,
            user_rating,
            tags,
            gps_lat,
            gps_lon,
            taken_at,
            orientation,
            needs_scan,
        });
    }

    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Json(BrowseResponse {
        path: rel.to_string_lossy().to_string(),
        entries,
    }))
}

async fn file_metadata(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> ApiResult<Json<FileMetaResponse>> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&query.path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    let meta = tokio::fs::metadata(&full_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;
    if !meta.is_file() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Not a file"));
    }

    let size = meta.len() as i64;
    let modified = to_unix_seconds(meta.modified().ok());

    let db_meta = db::get_file_meta(&state.pool, &query.path)
        .await
        .map_err(internal_error)?;

    let (camera_rating, gps_lat, gps_lon, taken_at, orientation, user_rating, tags) = match db_meta {
        Some(existing)
            if existing.file_size == size
                && existing.last_modified == modified
                && existing.orientation.is_some() =>
        (
            existing.camera_rating,
            existing.gps_lat,
            existing.gps_lon,
            existing.taken_at,
            existing.orientation,
            existing.user_rating,
            existing.tags,
        ),
        Some(existing) => {
            let full_canon_clone = full_canon.clone();
            let extracted = tokio::task::spawn_blocking(move || metadata::read_metadata(&full_canon_clone))
                .await
                .map_err(internal_error)?
                .map_err(internal_error)?;
            let new_meta = FileMeta {
                path: query.path.clone(),
                camera_rating: extracted.camera_rating,
                user_rating: existing.user_rating,
                tags: existing.tags.clone(),
                gps_lat: extracted.gps_lat,
                gps_lon: extracted.gps_lon,
                taken_at: extracted.taken_at,
                orientation: extracted.orientation.or(Some(0)),
                file_size: size,
                last_modified: modified,
            };
            db::upsert_file_meta(&state.pool, &new_meta)
                .await
                .map_err(internal_error)?;
            (
                new_meta.camera_rating,
                new_meta.gps_lat,
                new_meta.gps_lon,
                new_meta.taken_at,
                new_meta.orientation,
                new_meta.user_rating,
                new_meta.tags,
            )
        }
        None => {
            let full_canon_clone = full_canon.clone();
            let extracted = tokio::task::spawn_blocking(move || metadata::read_metadata(&full_canon_clone))
                .await
                .map_err(internal_error)?
                .map_err(internal_error)?;
            let new_meta = FileMeta {
                path: query.path.clone(),
                camera_rating: extracted.camera_rating,
                user_rating: None,
                tags: Vec::new(),
                gps_lat: extracted.gps_lat,
                gps_lon: extracted.gps_lon,
                taken_at: extracted.taken_at,
                orientation: extracted.orientation.or(Some(0)),
                file_size: size,
                last_modified: modified,
            };
            db::upsert_file_meta(&state.pool, &new_meta)
                .await
                .map_err(internal_error)?;
            (
                new_meta.camera_rating,
                new_meta.gps_lat,
                new_meta.gps_lon,
                new_meta.taken_at,
                new_meta.orientation,
                new_meta.user_rating,
                new_meta.tags,
            )
        }
    };

    let name = full_path
        .file_name()
        .unwrap_or_else(|| OsStr::new(""))
        .to_string_lossy()
        .to_string();

    Ok(Json(FileMetaResponse {
        path: query.path,
        name,
        camera_rating,
        user_rating,
        tags,
        gps_lat,
        gps_lon,
        taken_at,
        orientation,
        file_size: size,
        last_modified: modified,
    }))
}

async fn file_preview(
    State(state): State<AppState>,
    Query(query): Query<PreviewQuery>,
) -> ApiResult<Response> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&query.path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    let kind = match query.kind.as_deref() {
        Some("thumb") => metadata::PreviewKind::Thumb,
        _ => metadata::PreviewKind::Full,
    };
    let preview_path = metadata::preview_cache_path(&state.preview_dir, &query.path, kind);
    let full_canon_clone = full_canon.clone();
    let preview_path_clone = preview_path.clone();
    let generated = tokio::task::spawn_blocking(move || {
        metadata::ensure_preview(&full_canon_clone, &preview_path_clone, kind)
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;

    if !generated {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "No preview available",
        ));
    }

    let file = tokio::fs::File::open(&preview_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Preview not found"))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("image/jpeg"),
    );
    Ok(response)
}

async fn file_download(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> ApiResult<Response> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&query.path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    let file = tokio::fs::File::open(&full_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let filename = full_canon
        .file_name()
        .unwrap_or_else(|| OsStr::new("raw"))
        .to_string_lossy()
        .to_string();

    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(
            mime_guess::from_path(&full_canon)
                .first_or_octet_stream()
                .as_ref(),
        )
        .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename))
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

async fn set_rating(
    State(state): State<AppState>,
    Json(payload): Json<RatingRequest>,
) -> ApiResult<Json<RatingResponse>> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&payload.path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    if let Some(rating) = payload.rating {
        if !(0..=5).contains(&rating) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Rating must be 0-5",
            ));
        }
    }

    let meta = tokio::fs::metadata(&full_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;
    let size = meta.len() as i64;
    let modified = to_unix_seconds(meta.modified().ok());

    db::upsert_user_rating(&state.pool, &payload.path, payload.rating, size, modified)
        .await
        .map_err(internal_error)?;

    Ok(Json(RatingResponse {
        user_rating: payload.rating,
    }))
}

async fn set_tags(
    State(state): State<AppState>,
    Json(payload): Json<TagsRequest>,
) -> ApiResult<Json<TagsResponse>> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&payload.path)?;
    let full_path = root_canon.join(&rel);
    let full_canon = tokio::fs::canonicalize(&full_path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;

    if !full_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for tag in payload.tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.to_string();
        if seen.insert(normalized.to_lowercase()) {
            tags.push(normalized);
        }
    }

    let meta = tokio::fs::metadata(&full_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "File not found"))?;
    let size = meta.len() as i64;
    let modified = to_unix_seconds(meta.modified().ok());

    db::upsert_tags(&state.pool, &payload.path, &tags, size, modified)
        .await
        .map_err(internal_error)?;

    Ok(Json(TagsResponse { tags }))
}

async fn list_tags(State(state): State<AppState>) -> ApiResult<Json<TagsListResponse>> {
    let tags = db::list_tags(&state.pool)
        .await
        .map_err(internal_error)?;
    Ok(Json(TagsListResponse { tags }))
}

async fn fs_mkdir(
    State(state): State<AppState>,
    Json(payload): Json<MkdirRequest>,
) -> ApiResult<Json<FsResponse>> {
    let root_canon = get_root_canon(&state).await?;
    let rel = sanitize_relative(&payload.path)?;
    if rel.as_os_str().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Folder name is required",
        ));
    }

    let full_path = root_canon.join(&rel);
    let parent = full_path.parent().ok_or_else(|| {
        ApiError::new(StatusCode::BAD_REQUEST, "Invalid folder path")
    })?;
    let parent_canon = tokio::fs::canonicalize(parent)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Parent folder not found"))?;

    if !parent_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
    }

    if let Err(err) = tokio::fs::create_dir_all(&full_path).await {
        return Err(map_fs_error(err, "Unable to create folder"));
    }

    Ok(Json(FsResponse { success: true }))
}

async fn fs_delete(
    State(state): State<AppState>,
    Json(payload): Json<DeleteRequest>,
) -> ApiResult<Json<FsResponse>> {
    if payload.paths.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "No paths provided",
        ));
    }
    let root_canon = get_root_canon(&state).await?;

    for path in payload.paths {
        let rel = sanitize_relative(&path)?;
        if rel.as_os_str().is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Invalid path",
            ));
        }
        let rel_str = rel_to_string(&rel);
        let full_path = root_canon.join(&rel);
        let full_canon = tokio::fs::canonicalize(&full_path)
            .await
            .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Path not found"))?;

        if !full_canon.starts_with(&root_canon) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
        }

        let meta = tokio::fs::metadata(&full_canon)
            .await
            .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Path not found"))?;

        if meta.is_dir() {
            if payload.recursive {
                if let Err(err) = tokio::fs::remove_dir_all(&full_canon).await {
                    return Err(map_fs_error(err, "Unable to delete folder"));
                }
                db::delete_meta_prefix(&state.pool, &rel_str)
                    .await
                    .map_err(internal_error)?;
            } else {
                if let Err(err) = tokio::fs::remove_dir(&full_canon).await {
                    if err.kind() == io::ErrorKind::DirectoryNotEmpty {
                        return Err(ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "Directory not empty. Enable recursive delete.",
                        ));
                    }
                    return Err(map_fs_error(err, "Unable to delete folder"));
                }
            }
        } else {
            if let Err(err) = tokio::fs::remove_file(&full_canon).await {
                return Err(map_fs_error(err, "Unable to delete file"));
            }
            db::delete_meta(&state.pool, &rel_str)
                .await
                .map_err(internal_error)?;
        }
    }

    Ok(Json(FsResponse { success: true }))
}

async fn fs_move(
    State(state): State<AppState>,
    Json(payload): Json<MoveRequest>,
) -> ApiResult<Json<FsResponse>> {
    if payload.paths.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "No paths provided",
        ));
    }
    let root_canon = get_root_canon(&state).await?;
    let dest_rel = sanitize_relative(&payload.destination)?;
    let dest_full = root_canon.join(&dest_rel);
    let dest_canon = tokio::fs::canonicalize(&dest_full)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Destination not found"))?;

    if !dest_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid destination"));
    }

    let dest_meta = tokio::fs::metadata(&dest_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Destination not found"))?;

    if !dest_meta.is_dir() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Destination must be a folder",
        ));
    }

    for path in payload.paths {
        let rel = sanitize_relative(&path)?;
        if rel.as_os_str().is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Invalid path",
            ));
        }
        let rel_str = rel_to_string(&rel);
        let full_path = root_canon.join(&rel);
        let full_canon = tokio::fs::canonicalize(&full_path)
            .await
            .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Path not found"))?;

        if !full_canon.starts_with(&root_canon) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid path"));
        }

        let meta = tokio::fs::metadata(&full_canon)
            .await
            .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Path not found"))?;

        if meta.is_dir() && dest_canon.starts_with(&full_canon) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Cannot move a folder into itself",
            ));
        }

        let name = full_canon
            .file_name()
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Invalid path"))?;
        let target_rel = join_rel(&dest_rel, name);
        let target_rel_str = rel_to_string(&target_rel);
        let target_full = root_canon.join(&target_rel);

        if tokio::fs::metadata(&target_full).await.is_ok() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Destination already exists",
            ));
        }

        if let Err(err) = tokio::fs::rename(&full_canon, &target_full).await {
            if is_cross_device_link(&err) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Cross-device move not supported",
                ));
            }
            return Err(map_fs_error(err, "Unable to move path"));
        }

        if meta.is_dir() {
            db::move_meta_prefix(&state.pool, &rel_str, &target_rel_str)
                .await
                .map_err(internal_error)?;
        } else {
            db::move_meta(&state.pool, &rel_str, &target_rel_str)
                .await
                .map_err(internal_error)?;
        }
    }

    Ok(Json(FsResponse { success: true }))
}

async fn fs_upload(
    State(state): State<AppState>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<FsResponse>> {
    let root_canon = get_root_canon(&state).await?;
    let dest_rel = sanitize_relative(query.path.as_deref().unwrap_or(""))?;
    let dest_full = root_canon.join(&dest_rel);
    let dest_canon = tokio::fs::canonicalize(&dest_full)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Destination not found"))?;

    if !dest_canon.starts_with(&root_canon) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Invalid destination"));
    }

    let dest_meta = tokio::fs::metadata(&dest_canon)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "Destination not found"))?;
    if !dest_meta.is_dir() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Destination must be a folder",
        ));
    }

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(internal_error)?
    {
        let file_name = field
            .file_name()
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Missing file name"))?;
        let safe_name = Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Invalid file name"))?;

        if !is_supported_raw(Path::new(safe_name)) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Unsupported file type",
            ));
        }

        let target_full = dest_canon.join(safe_name);
        if tokio::fs::metadata(&target_full).await.is_ok() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "File already exists",
            ));
        }

        let mut file = tokio::fs::File::create(&target_full)
            .await
            .map_err(|err| map_fs_error(err, "Unable to create file"))?;
        let mut field = field;
        while let Some(chunk) = field.chunk().await.map_err(internal_error)? {
            file.write_all(&chunk)
                .await
                .map_err(|err| map_fs_error(err, "Unable to write file"))?;
        }
    }

    Ok(Json(FsResponse { success: true }))
}

fn is_cross_device_link(err: &io::Error) -> bool {
    #[cfg(target_family = "unix")]
    {
        return err.raw_os_error() == Some(libc::EXDEV);
    }

    #[cfg(not(target_family = "unix"))]
    {
        let _ = err;
        return false;
    }
}

fn sanitize_relative(path: &str) -> ApiResult<PathBuf> {
    let trimmed = path.trim_matches('/');
    let rel = PathBuf::from(trimmed);

    if rel.is_absolute() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid path"));
    }

    for component in rel.components() {
        if matches!(component, Component::ParentDir) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid path"));
        }
    }

    Ok(rel)
}

fn rel_to_string(rel: &Path) -> String {
    rel.to_string_lossy().to_string()
}

fn join_rel(base: &Path, name: &OsStr) -> PathBuf {
    if base.as_os_str().is_empty() {
        PathBuf::from(name)
    } else {
        base.join(name)
    }
}

fn is_supported_raw(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    matches!(
        ext.as_str(),
        "arw"
            | "dng"
            | "cr2"
            | "cr3"
            | "nef"
            | "raf"
            | "orf"
            | "rw2"
            | "srw"
            | "pef"
    )
}

async fn get_root_canon(state: &AppState) -> ApiResult<PathBuf> {
    state
        .library_root_canon
        .read()
        .await
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "Library not configured"))
}

fn to_unix_seconds(time: Option<SystemTime>) -> i64 {
    time.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn internal_error(err: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Internal error: {err}"),
    )
}

fn map_fs_error(err: io::Error, message: &str) -> ApiError {
    if err.kind() == io::ErrorKind::PermissionDenied {
        return ApiError::new(StatusCode::FORBIDDEN, format!("{message}: permission denied"));
    }
    ApiError::new(StatusCode::BAD_REQUEST, format!("{message}: {err}"))
}

fn read_library_root_env() -> Option<String> {
    let value = env::var("RAW_MANAGER_LIBRARY_ROOT")
        .ok()
        .or_else(|| env::var("RAW_LIBRARY_ROOT").ok());
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}
