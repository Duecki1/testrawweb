use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub path: String,
    pub camera_rating: Option<i32>,
    pub user_rating: Option<i32>,
    pub tags: Vec<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub taken_at: Option<String>,
    pub orientation: Option<i32>,
    pub file_size: i64,
    pub last_modified: i64,
}

pub async fn init_db(pool: &SqlitePool) -> Result<()> {
    create_files_table(pool).await?;
    ensure_files_schema(pool).await?;

    Ok(())
}

pub async fn get_file_meta(pool: &SqlitePool, path: &str) -> Result<Option<FileMeta>> {
    let row = sqlx::query(
        r#"
        SELECT path, camera_rating, user_rating, tags, gps_lat, gps_lon, taken_at, file_size, last_modified, orientation
        FROM files
        WHERE path = ?
        "#,
    )
    .bind(path)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(row_to_meta))
}

pub async fn upsert_file_meta(pool: &SqlitePool, meta: &FileMeta) -> Result<()> {
    let tags_json = serde_json::to_string(&meta.tags)?;
    sqlx::query(
        r#"
        INSERT INTO files (
            path, camera_rating, user_rating, tags, gps_lat, gps_lon, taken_at, file_size, last_modified, orientation
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            camera_rating = excluded.camera_rating,
            user_rating = excluded.user_rating,
            tags = excluded.tags,
            gps_lat = excluded.gps_lat,
            gps_lon = excluded.gps_lon,
            taken_at = excluded.taken_at,
            file_size = excluded.file_size,
            last_modified = excluded.last_modified,
            orientation = excluded.orientation;

        "#,
    )
    .bind(&meta.path)
    .bind(meta.camera_rating)
    .bind(meta.user_rating)
    .bind(tags_json)
    .bind(meta.gps_lat)
    .bind(meta.gps_lon)
    .bind(&meta.taken_at)
    .bind(meta.file_size)
    .bind(meta.last_modified)
    .bind(meta.orientation)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn upsert_user_rating(
    pool: &SqlitePool,
    path: &str,
    rating: Option<i32>,
    file_size: i64,
    last_modified: i64,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO files (path, user_rating, tags, file_size, last_modified)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            user_rating = excluded.user_rating,
            file_size = excluded.file_size,
            last_modified = excluded.last_modified;
        "#,
    )
    .bind(path)
    .bind(rating)
    .bind("[]")
    .bind(file_size)
    .bind(last_modified)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn upsert_tags(
    pool: &SqlitePool,
    path: &str,
    tags: &[String],
    file_size: i64,
    last_modified: i64,
) -> Result<()> {
    let tags_json = serde_json::to_string(tags)?;
    sqlx::query(
        r#"
        INSERT INTO files (path, user_rating, tags, file_size, last_modified)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            tags = excluded.tags,
            file_size = excluded.file_size,
            last_modified = excluded.last_modified;
        "#,
    )
    .bind(path)
    .bind(None::<i32>)
    .bind(tags_json)
    .bind(file_size)
    .bind(last_modified)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_meta(pool: &SqlitePool, path: &str) -> Result<()> {
    sqlx::query("DELETE FROM files WHERE path = ?")
        .bind(path)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_meta_prefix(pool: &SqlitePool, prefix: &str) -> Result<()> {
    let prefix = prefix.trim_matches('/');
    let like_pattern = format!("{}/%", prefix);
    sqlx::query("DELETE FROM files WHERE path = ? OR path LIKE ?")
        .bind(prefix)
        .bind(like_pattern)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn move_meta(pool: &SqlitePool, from_path: &str, to_path: &str) -> Result<()> {
    sqlx::query("UPDATE files SET path = ? WHERE path = ?")
        .bind(to_path)
        .bind(from_path)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn move_meta_prefix(
    pool: &SqlitePool,
    from_prefix: &str,
    to_prefix: &str,
) -> Result<()> {
    let from_prefix = from_prefix.trim_matches('/');
    let to_prefix = to_prefix.trim_matches('/');
    let like_pattern = format!("{}/%", from_prefix);
    let target_prefix = if to_prefix.is_empty() {
        "".to_string()
    } else {
        format!("{}/", to_prefix)
    };
    let start_index = from_prefix.len() + 2;
    sqlx::query(
        "UPDATE files SET path = ? || substr(path, ?) WHERE path LIKE ?",
    )
    .bind(target_prefix)
    .bind(start_index as i64)
    .bind(like_pattern)
    .execute(pool)
    .await?;
    Ok(())
}

fn row_to_meta(row: SqliteRow) -> FileMeta {
    let tags_raw: Option<String> = row.get("tags");
    let tags: Vec<String> = tags_raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    FileMeta {
        path: row.get("path"),
        camera_rating: row.get("camera_rating"),
        user_rating: row.get("user_rating"),
        tags,
        gps_lat: row.get("gps_lat"),
        gps_lon: row.get("gps_lon"),
        taken_at: row.get("taken_at"),
        orientation: row.get("orientation"),
        file_size: row.get("file_size"),
        last_modified: row.get("last_modified"),
    }
}

async fn create_files_table(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS files (\
            path TEXT PRIMARY KEY,\
            camera_rating INTEGER,\
            user_rating INTEGER,\
            tags TEXT,\
            gps_lat REAL,\
            gps_lon REAL,\
            taken_at TEXT,\
            orientation INTEGER,\
            file_size INTEGER NOT NULL,\
            last_modified INTEGER NOT NULL\
        );",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_files_schema(pool: &SqlitePool) -> Result<()> {
    let columns = list_columns(pool, "files").await?;
    if columns.is_empty() {
        return Ok(());
    }

    if !columns.contains("path") {
        let legacy_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let legacy_name = format!("files_legacy_{}", legacy_suffix);
        let rename_sql = format!("ALTER TABLE files RENAME TO {}", legacy_name);
        sqlx::query(&rename_sql).execute(pool).await?;
        create_files_table(pool).await?;
        return Ok(());
    }

    let required = [
        ("camera_rating", "INTEGER"),
        ("user_rating", "INTEGER"),
        ("tags", "TEXT"),
        ("gps_lat", "REAL"),
        ("gps_lon", "REAL"),
        ("taken_at", "TEXT"),
        ("orientation", "INTEGER"),
        ("file_size", "INTEGER NOT NULL DEFAULT 0"),
        ("last_modified", "INTEGER NOT NULL DEFAULT 0"),
    ];

    for (name, ty) in required {
        if !columns.contains(name) {
            let sql = format!("ALTER TABLE files ADD COLUMN {} {}", name, ty);
            sqlx::query(&sql).execute(pool).await?;
        }
    }

    Ok(())
}

async fn list_columns(pool: &SqlitePool, table: &str) -> Result<HashSet<String>> {
    let query = format!("PRAGMA table_info({});", table);
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    let mut columns = HashSet::new();
    for row in rows {
        let name: String = row.get("name");
        columns.insert(name);
    }
    Ok(columns)
}
