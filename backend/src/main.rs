use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, FixedOffset, Months, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    FromRow, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{collections::BTreeMap, str::FromStr};
use uuid::Uuid;

mod assistant;

const INCOME_CATEGORIES: [&str; 5] = ["membership", "pt", "class", "retail", "daily"];

#[derive(Clone)]
struct App {
    db: SqlitePool,
}
fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
async fn add_admin(db: &SqlitePool, token: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO admin_access_codes(token_hash,label,created_at) VALUES(?, 'Quản trị viên', ?) ON CONFLICT(token_hash) DO NOTHING")
        .bind(token_hash(token)).bind(now()).execute(db).await?;
    Ok(())
}
type ApiError = (StatusCode, String);
fn bad(s: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, s.into())
}
fn db_error(e: sqlx::Error) -> ApiError {
    eprintln!("Database error: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Không thể xử lý dữ liệu. Vui lòng thử lại.".into(),
    )
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn local_date(s: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(s).ok().map(|date| {
        date.with_timezone(&FixedOffset::east_opt(7 * 3600).unwrap())
            .date_naive()
    })
}
fn timestamp(s: &str) -> Result<String, ApiError> {
    let normalized = DateTime::parse_from_rfc3339(s)
        .map_err(|_| bad("Thời điểm không hợp lệ."))?
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    DateTime::parse_from_rfc3339(&normalized).map_err(|_| bad("Thời điểm không hợp lệ."))?;
    Ok(normalized)
}

fn payment_request_hash(payment: &Payment) -> String {
    let mut payload = vec![
        serde_json::json!(payment.member),
        serde_json::json!(payment.description),
        serde_json::json!(payment.category),
        serde_json::json!(payment.method),
        serde_json::json!(payment.amount),
        serde_json::json!(payment.status),
        serde_json::json!(payment.occurred_at),
    ];
    // Preserve the hash for requests saved before membership months were added.
    if let Some(months) = payment.membership_months {
        payload.push(serde_json::json!(months));
    }
    format!(
        "{:x}",
        Sha256::digest(serde_json::Value::Array(payload).to_string().as_bytes())
    )
}

fn request_conflict() -> ApiError {
    (
        StatusCode::CONFLICT,
        "Yêu cầu này đã được ghi nhận với nội dung khác. Hãy kiểm tra giao dịch trước khi gửi lại."
            .into(),
    )
}

#[derive(Serialize, FromRow, Clone)]
struct Payment {
    id: String,
    member: String,
    description: String,
    category: String,
    membership_months: Option<i64>,
    method: String,
    amount: i64,
    status: String,
    occurred_at: String,
}
#[derive(Serialize, FromRow, Clone)]
struct Refund {
    id: String,
    transaction_id: String,
    amount: i64,
    reason: String,
    occurred_at: String,
}
#[derive(Deserialize, Default)]
struct Filters {
    from: Option<String>,
    to: Option<String>,
    category: Option<String>,
    method: Option<String>,
    status: Option<String>,
    q: Option<String>,
    page: Option<usize>,
    expired_memberships: Option<bool>,
}
impl Filters {
    fn validate(&self) -> Result<(), ApiError> {
        for s in [&self.from, &self.to].into_iter().flatten() {
            let date = NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map_err(|_| bad("Ngày lọc không hợp lệ."))?;
            if date.format("%Y-%m-%d").to_string() != *s || s.len() != 10 {
                return Err(bad("Ngày lọc phải theo định dạng YYYY-MM-DD."));
            }
        }
        if self
            .from
            .as_ref()
            .zip(self.to.as_ref())
            .is_some_and(|(a, b)| a > b)
        {
            return Err(bad("Ngày kết thúc phải sau ngày bắt đầu."));
        }
        Ok(())
    }
    fn date(&self, s: &str) -> bool {
        let Some(date) = local_date(s) else {
            eprintln!("Invalid stored timestamp excluded from report");
            return false;
        };
        let date = date.to_string();
        self.from.as_ref().is_none_or(|x| date >= *x) && self.to.as_ref().is_none_or(|x| date <= *x)
    }
    fn matches(&self, p: &Payment) -> bool {
        self.category
            .as_ref()
            .is_none_or(|x| x.is_empty() || *x == p.category)
            && self
                .method
                .as_ref()
                .is_none_or(|x| x.is_empty() || *x == p.method)
            && self
                .status
                .as_ref()
                .is_none_or(|x| x.is_empty() || *x == p.status)
            && self.q.as_ref().is_none_or(|x| {
                format!("{} {} {}", p.id, p.member, p.description)
                    .to_lowercase()
                    .contains(&x.to_lowercase())
            })
    }
}
async fn auth(State(s): State<App>, req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "));
    let valid = if let Some(token) = token {
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM admin_access_codes WHERE token_hash=? AND revoked_at IS NULL)")
            .bind(token_hash(token)).fetch_one(&s.db).await
    } else {
        Ok(false)
    };
    if matches!(valid, Ok(true)) {
        next.run(req).await
    } else if let Err(e) = valid {
        db_error(e).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "Phiên truy cập không hợp lệ.").into_response()
    }
}
struct FilteredTransactions {
    payments: Vec<Payment>,
    refunds: Vec<Refund>,
    refunded_by_transaction: BTreeMap<String, i64>,
}

async fn data(s: &App, f: &Filters) -> Result<FilteredTransactions, ApiError> {
    f.validate()?;
    let mut snapshot = s.db.begin().await.map_err(db_error)?;
    let all=sqlx::query_as::<_,Payment>("SELECT id,member,description,category,membership_months,method,amount,status,occurred_at FROM transactions ORDER BY occurred_at DESC,id").fetch_all(&mut *snapshot).await.map_err(db_error)?;
    let refunds = sqlx::query_as::<_, Refund>(
        "SELECT id,transaction_id,amount,reason,occurred_at FROM refunds ORDER BY occurred_at DESC",
    )
    .fetch_all(&mut *snapshot)
    .await
    .map_err(db_error)?;
    snapshot.commit().await.map_err(db_error)?;
    let matched: Vec<_> = all.into_iter().filter(|p| f.matches(p)).collect();
    let mut refunded_by_transaction = BTreeMap::new();
    for refund in &refunds {
        *refunded_by_transaction
            .entry(refund.transaction_id.clone())
            .or_default() += refund.amount;
    }
    let refunds = refunds
        .into_iter()
        .filter(|r| f.date(&r.occurred_at) && matched.iter().any(|p| p.id == r.transaction_id))
        .collect();
    Ok(FilteredTransactions {
        payments: matched
            .into_iter()
            .filter(|p| f.date(&p.occurred_at))
            .collect(),
        refunds,
        refunded_by_transaction,
    })
}
#[derive(Serialize)]
struct OverviewItem {
    #[serde(flatten)]
    payment: Payment,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_on: Option<NaiveDate>,
    refunded_amount: i64,
}

async fn expired_memberships(
    db: &SqlitePool,
    query: Option<&str>,
    today: NaiveDate,
) -> Result<Vec<OverviewItem>, ApiError> {
    let payments = sqlx::query_as::<_, Payment>(
        "SELECT id,member,description,category,membership_months,method,amount,status,occurred_at
         FROM transactions
         WHERE category='membership' AND status='paid' AND membership_months IS NOT NULL
         ORDER BY occurred_at DESC,id",
    )
    .fetch_all(db)
    .await
    .map_err(db_error)?;
    let mut memberships = BTreeMap::new();
    for payment in payments {
        let (Some(start), Some(months)) =
            (local_date(&payment.occurred_at), payment.membership_months)
        else {
            continue;
        };
        if start > today {
            continue;
        }
        let end = u32::try_from(months)
            .ok()
            .and_then(|months| start.checked_add_months(Months::new(months)))
            .unwrap_or(NaiveDate::MAX);
        let member = payment.member.trim().to_lowercase();
        if memberships
            .get(&member)
            .is_none_or(|(previous, _)| end > *previous)
        {
            memberships.insert(member, (end, payment));
        }
    }
    let search = Filters {
        q: query.map(str::to_owned),
        ..Filters::default()
    };
    let mut items: Vec<_> = memberships
        .into_values()
        .filter(|(end, payment)| *end <= today && search.matches(payment))
        .map(|(end, payment)| OverviewItem {
            payment,
            expires_on: Some(end),
            refunded_amount: 0,
        })
        .collect();
    items.sort_by(|a, b| {
        b.expires_on
            .cmp(&a.expires_on)
            .then_with(|| a.payment.member.cmp(&b.payment.member))
    });
    Ok(items)
}

async fn overview(
    State(s): State<App>,
    Query(f): Query<Filters>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let FilteredTransactions {
        payments,
        refunds,
        refunded_by_transaction,
    } = data(&s, &f).await?;
    let gross: i64 = payments
        .iter()
        .filter(|p| p.status == "paid")
        .map(|p| p.amount)
        .sum();
    let refunded: i64 = refunds.iter().map(|r| r.amount).sum();
    let count = payments.iter().filter(|p| p.status == "paid").count();
    let mut daily: BTreeMap<NaiveDate, (i64, i64)> = BTreeMap::new();
    let mut categories: BTreeMap<String, i64> = BTreeMap::new();
    for p in payments.iter().filter(|p| p.status == "paid") {
        if let Some(date) = local_date(&p.occurred_at) {
            daily.entry(date).or_default().0 += p.amount;
        }
        *categories.entry(p.category.clone()).or_default() += p.amount;
    }
    for r in &refunds {
        if let Some(date) = local_date(&r.occurred_at) {
            daily.entry(date).or_default().1 += r.amount;
        }
    }
    let show_expired = f.expired_memberships.unwrap_or(false);
    let items = if show_expired {
        let today = local_date(&now()).ok_or_else(|| bad("Không thể xác định ngày hiện tại."))?;
        expired_memberships(&s.db, f.q.as_deref(), today).await?
    } else {
        payments
            .into_iter()
            .map(|payment| OverviewItem {
                payment,
                expires_on: None,
                refunded_amount: 0,
            })
            .collect()
    };
    let total = items.len();
    let pages = total.div_ceil(10).max(1);
    let page = f.page.unwrap_or(1).clamp(1, pages);
    let items: Vec<_> = items
        .into_iter()
        .skip((page - 1) * 10)
        .take(10)
        .map(|mut item| {
            item.refunded_amount = refunded_by_transaction
                .get(&item.payment.id)
                .copied()
                .unwrap_or_default();
            item
        })
        .collect();
    Ok(Json(
        serde_json::json!({"gross":gross,"refunded":refunded,"net":gross-refunded,"count":count,"daily":daily.into_iter().map(|(date,(income,refund))|serde_json::json!({"date":date,"income":income,"refund":refund})).collect::<Vec<_>>(),"categories":categories,"items":items,"total":total,"page":page,"pages":pages,"expired_memberships":show_expired}),
    ))
}
#[derive(Deserialize)]
struct NewPayment {
    member: String,
    description: String,
    category: String,
    membership_months: Option<i64>,
    method: String,
    amount: i64,
    status: String,
    occurred_at: String,
    idempotency_key: String,
}
async fn create(
    State(s): State<App>,
    Json(p): Json<NewPayment>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if p.member.trim().is_empty()
        || p.member.chars().count() > 120
        || p.description.trim().is_empty()
        || p.description.chars().count() > 500
        || !(1..=100_000_000_000).contains(&p.amount)
        || !INCOME_CATEGORIES.contains(&p.category.as_str())
        || !["cash", "transfer", "card"].contains(&p.method.as_str())
        || !["paid", "pending", "failed"].contains(&p.status.as_str())
        || p.idempotency_key.len() < 8
        || p.idempotency_key.len() > 100
    {
        return Err(bad("Vui lòng kiểm tra nội dung và số tiền khoản thu."));
    }
    if p.membership_months
        .is_some_and(|months| months <= 0 || p.category != "membership")
    {
        return Err(bad(
            "Tổng tháng phải là số nguyên dương và chỉ áp dụng cho gói hội viên.",
        ));
    }
    let date = timestamp(&p.occurred_at)?;
    if p.status == "paid" && date > now() {
        return Err(bad("Thời điểm khoản đã thu không được ở tương lai."));
    }
    let mut tx = s.db.begin().await.map_err(db_error)?;
    let payment = Payment {
        id: format!("TA-{}", &Uuid::new_v4().to_string()[..8]),
        member: p.member.trim().to_owned(),
        description: p.description.trim().to_owned(),
        category: p.category,
        membership_months: p.membership_months,
        method: p.method,
        amount: p.amount,
        status: p.status,
        occurred_at: date,
    };
    let request_hash = payment_request_hash(&payment);
    let inserted = sqlx::query("INSERT INTO transactions(id,member,description,category,method,amount,status,occurred_at,idempotency_key,membership_months) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING")
        .bind(&payment.id)
        .bind(&payment.member)
        .bind(&payment.description)
        .bind(&payment.category)
        .bind(&payment.method)
        .bind(payment.amount)
        .bind(&payment.status)
        .bind(&payment.occurred_at)
        .bind(&p.idempotency_key)
        .bind(payment.membership_months)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?
        .rows_affected();
    let actual;
    if inserted > 0 {
        actual = payment.id;
        sqlx::query("INSERT INTO payment_requests(transaction_id,payload_hash) VALUES(?,?)")
            .bind(&actual)
            .bind(&request_hash)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        sqlx::query(
            "INSERT INTO audit_log(action,entity_id,occurred_at) VALUES('payment_created',?,?)",
        )
        .bind(&actual)
        .bind(now())
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    } else {
        let existing = sqlx::query_as::<_, Payment>(
            "SELECT id,member,description,category,membership_months,method,amount,status,occurred_at FROM transactions WHERE idempotency_key=?",
        )
        .bind(&p.idempotency_key)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
        let original_hash: Option<String> =
            sqlx::query_scalar("SELECT payload_hash FROM payment_requests WHERE transaction_id=?")
                .bind(&existing.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?;
        if original_hash.unwrap_or_else(|| payment_request_hash(&existing)) != request_hash {
            return Err(request_conflict());
        }
        actual = existing.id;
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(serde_json::json!({"id":actual})))
}
async fn detail(
    State(s): State<App>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let p=sqlx::query_as::<_,Payment>("SELECT id,member,description,category,membership_months,method,amount,status,occurred_at FROM transactions WHERE id=?").bind(&id).fetch_optional(&s.db).await.map_err(db_error)?.ok_or((StatusCode::NOT_FOUND,"Không tìm thấy giao dịch.".into()))?;
    let refunds=sqlx::query_as::<_,Refund>("SELECT id,transaction_id,amount,reason,occurred_at FROM refunds WHERE transaction_id=? ORDER BY occurred_at DESC").bind(id).fetch_all(&s.db).await.map_err(db_error)?;
    Ok(Json(serde_json::json!({"payment":p,"refunds":refunds})))
}
async fn settle(
    State(s): State<App>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM transactions WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    match status.as_deref() {
        Some("paid") => return Ok(Json(serde_json::json!({"id":id}))),
        Some("pending") => {}
        _ => return Err(bad("Chỉ xác nhận khoản đang chờ thanh toán.")),
    }
    let at = now();
    sqlx::query("UPDATE transactions SET status='paid',occurred_at=? WHERE id=?")
        .bind(&at)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query(
        "INSERT INTO audit_log(action,entity_id,occurred_at) VALUES('payment_settled',?,?)",
    )
    .bind(&id)
    .bind(at)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(serde_json::json!({"id":id})))
}
#[derive(Deserialize)]
struct NewRefund {
    amount: i64,
    reason: String,
    idempotency_key: String,
}
async fn refund(
    State(s): State<App>,
    Path(id): Path<String>,
    Json(r): Json<NewRefund>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if r.amount <= 0
        || r.reason.trim().is_empty()
        || r.reason.chars().count() > 500
        || r.idempotency_key.len() < 8
        || r.idempotency_key.len() > 100
    {
        return Err(bad("Số tiền và lý do hoàn tiền không hợp lệ."));
    }
    // Immediate transaction serializes concurrent refund checks before any reads.
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    let existing = sqlx::query_as::<_, Refund>(
        "SELECT id,transaction_id,amount,reason,occurred_at FROM refunds WHERE idempotency_key=?",
    )
    .bind(&r.idempotency_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if let Some(existing) = existing {
        if existing.transaction_id != id
            || existing.amount != r.amount
            || existing.reason != r.reason.trim()
        {
            return Err(request_conflict());
        }
        return Ok(Json(serde_json::json!({"id":existing.id})));
    }
    let available:Option<i64>=sqlx::query_scalar("SELECT amount - COALESCE((SELECT SUM(amount) FROM refunds WHERE transaction_id=transactions.id),0) FROM transactions WHERE id=? AND status='paid'").bind(&id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if available.is_none_or(|v| r.amount > v) {
        return Err(bad("Chỉ hoàn khoản đã thu và không vượt số tiền còn lại."));
    }
    let rid = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO refunds VALUES(?,?,?,?,?,?)")
        .bind(&rid)
        .bind(&id)
        .bind(r.amount)
        .bind(r.reason.trim())
        .bind(now())
        .bind(r.idempotency_key)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("INSERT INTO audit_log(action,entity_id,occurred_at) VALUES('refund_created',?,?)")
        .bind(&id)
        .bind(now())
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(serde_json::json!({"id":rid})))
}
fn cell(s: &str) -> String {
    let safe = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.into()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}
async fn export(State(s): State<App>, Query(f): Query<Filters>) -> Result<Response, ApiError> {
    let FilteredTransactions {
        payments, refunds, ..
    } = data(&s, &f).await?;
    let mut csv="\u{feff}Loại,Mã phiếu,Hội viên,Nội dung,Nguồn thu,Phương thức,Trạng thái,Số tiền VND,Thời điểm UTC\r\n".to_string();
    for p in payments {
        csv.push_str(
            &[
                "Thu".into(),
                p.id,
                p.member,
                p.description,
                p.category,
                p.method,
                p.status,
                p.amount.to_string(),
                p.occurred_at,
            ]
            .iter()
            .enumerate()
            .map(|(index, v)| {
                if index == 7 {
                    format!("\"{v}\"")
                } else {
                    cell(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        );
        csv.push_str("\r\n");
    }
    for r in refunds {
        csv.push_str(
            &[
                "Hoàn".into(),
                r.transaction_id,
                "".into(),
                r.reason,
                "".into(),
                "".into(),
                "refunded".into(),
                (-r.amount).to_string(),
                r.occurred_at,
            ]
            .iter()
            .enumerate()
            .map(|(index, v)| {
                if index == 7 {
                    format!("\"{v}\"")
                } else {
                    cell(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        );
        csv.push_str("\r\n");
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=thien-an-thu-nhap.csv",
            ),
        ],
        csv,
    )
        .into_response())
}
fn router(s: App) -> Router {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/transactions", post(create))
        .route("/api/transactions/{id}", get(detail))
        .route("/api/transactions/{id}/settle", post(settle))
        .route("/api/transactions/{id}/refunds", post(refund))
        .route("/api/export", get(export))
        .route(
            "/api/assistant/chat",
            post(assistant::chat).layer(assistant::body_limit()),
        )
        .route_layer(middleware::from_fn_with_state(s.clone(), auth))
        .with_state(s)
        .route_service(
            "/tro-ly-ai",
            tower_http::services::ServeFile::new("../frontend/dist/index.html"),
        )
        .fallback_service(
            tower_http::services::ServeDir::new("../frontend/dist")
                .append_index_html_on_directories(true),
        )
}
#[tokio::main]
async fn main() {
    let url = std::env::var("DATABASE_URL").unwrap_or("sqlite://thien-an.db".into());
    let opts = SqliteConnectOptions::from_str(&url)
        .unwrap()
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(10));
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await
        .unwrap();
    sqlx::migrate!().run(&db).await.unwrap();
    if let Ok(token) = std::env::var("THIEN_AN_TOKEN") {
        assert!(
            token.len() >= 16,
            "THIEN_AN_TOKEN must have at least 16 characters"
        );
        add_admin(&db, &token).await.unwrap();
    }
    if std::env::args().any(|a| a == "--create-admin") {
        let token = format!("TA-{}", Uuid::new_v4().simple());
        add_admin(&db, &token).await.unwrap();
        println!("Mã truy cập quản trị (chỉ hiển thị một lần): {token}");
        return;
    }
    if std::env::args().any(|a| a == "--seed") {
        seed(&db).await;
        return;
    }
    let address = std::env::var("THIEN_AN_BIND").unwrap_or("127.0.0.1:3001".into());
    let listener = tokio::net::TcpListener::bind(&address).await.unwrap();
    println!("Thiên Ân: http://{address}");
    axum::serve(
        listener,
        router(App { db }).layer(axum::Extension(assistant::Service::from_env())),
    )
    .await
    .unwrap();
}
async fn seed(db: &SqlitePool) {
    let names = [
        "Nguyễn Minh Anh",
        "Trần Hoàng Nam",
        "Lê Ngọc Hân",
        "Phạm Đức Huy",
        "Võ Thảo Vy",
        "Đặng Tuấn Kiệt",
    ];
    let cats = [
        ("membership", "Gói hội viên 3 tháng", 1_450_000),
        ("pt", "Huấn luyện cá nhân 12 buổi", 3_650_000),
        ("class", "Lớp yoga tháng", 790_000),
        ("retail", "Găng tay tập luyện", 285_000),
    ];
    for i in 0..32 {
        let (cat, desc, amount) = cats[i % 4];
        let date = (Utc::now() - chrono::Duration::days((i % 25) as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        sqlx::query("INSERT OR IGNORE INTO transactions(id,member,description,category,method,amount,status,occurred_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(format!("TA-DEMO-{i:03}"))
            .bind(names[i % 6])
            .bind(desc)
            .bind(cat)
            .bind(["transfer", "cash", "card"][i % 3])
            .bind(amount)
            .bind(if i % 9 == 0 { "pending" } else { "paid" })
            .bind(date)
            .bind(format!("demo-seed-{i}"))
            .execute(db)
            .await
            .unwrap();
    }
    println!("Đã thêm 32 giao dịch mẫu (TA-DEMO). Không phải dữ liệu thật.");
}

#[cfg(test)]
mod tests;
