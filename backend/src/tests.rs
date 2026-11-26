use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn app() -> App {
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!().run(&db).await.unwrap();
    add_admin(&db, "test-access-token").await.unwrap();
    App { db }
}

#[tokio::test]
async fn database_codes_are_hashed_and_revocation_is_immediate() {
    let s = app().await;
    let hash: String = sqlx::query_scalar("SELECT token_hash FROM admin_access_codes")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(hash, token_hash("test-access-token"));
    assert_ne!(hash, "test-access-token");
    assert_eq!(
        request(&s, "GET", "/api/overview", serde_json::Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE admin_access_codes SET revoked_at=?")
        .bind(now())
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        request(&s, "GET", "/api/overview", serde_json::Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    add_admin(&s.db, "test-access-token").await.unwrap();
    assert_eq!(
        request(&s, "GET", "/api/overview", serde_json::Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
async fn request(
    s: &App,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let res = router(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", "Bearer test-access-token")
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::String(
            String::from_utf8_lossy(&bytes).into(),
        )),
    )
}
fn payment(key: &str, status: &str, amount: i64, at: &str) -> serde_json::Value {
    serde_json::json!({"member":"Nguyễn Minh Anh","description":"Gói hội viên","category":"membership","method":"transfer","amount":amount,"status":status,"occurred_at":at,"idempotency_key":key})
}

#[tokio::test]
async fn totals_exclude_pending_failed_and_respect_vietnam_midnight() {
    let s = app().await;
    for (key, status, amount, at) in [
        ("paid-key-1", "paid", 900000, "2026-10-31T17:00:00Z"),
        ("pending-key", "pending", 500000, "2026-11-01T01:00:00Z"),
        ("failed-key", "failed", 600000, "2026-11-01T01:00:00Z"),
        ("previous-key", "paid", 200000, "2026-10-31T16:59:59Z"),
    ] {
        assert_eq!(
            request(
                &s,
                "POST",
                "/api/transactions",
                payment(key, status, amount, at)
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let (_, v) = request(
        &s,
        "GET",
        "/api/overview?from=2026-11-01&to=2026-11-01",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(v["gross"], 900000);
    assert_eq!(v["count"], 1);
    assert_eq!(v["total"], 3);
}
#[tokio::test]
async fn retries_do_not_duplicate_payments_or_audit() {
    let s = app().await;
    let p = payment(
        "same-request-key",
        "paid",
        100000,
        "2026-11-01T09:00:00+07:00",
    );
    let a = request(&s, "POST", "/api/transactions", p.clone()).await;
    let b = request(&s, "POST", "/api/transactions", p.clone()).await;
    assert_eq!(a.1, b.1);
    let mut changed = p;
    changed["amount"] = serde_json::json!(200000);
    assert_eq!(
        request(&s, "POST", "/api/transactions", changed).await.0,
        StatusCode::CONFLICT
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(n, 1);
}
#[tokio::test]
async fn membership_months_persist_and_participate_in_retries() {
    let s = app().await;
    let path = "/api/transactions";
    let mut input = payment(
        "membership-months-key",
        "paid",
        400000,
        "2026-01-01T00:00:00Z",
    );
    input["membership_months"] = serde_json::json!(4);
    let created = request(&s, "POST", path, input.clone()).await;
    assert_eq!(created.0, StatusCode::OK);
    assert_eq!(request(&s, "POST", path, input.clone()).await, created);
    let detail_path = format!("{path}/{}", created.1["id"].as_str().unwrap());
    let (_, detail) = request(&s, "GET", &detail_path, serde_json::Value::Null).await;
    assert_eq!(detail["payment"]["membership_months"], 4);

    input["membership_months"] = serde_json::json!(5);
    assert_eq!(
        request(&s, "POST", path, input.clone()).await.0,
        StatusCode::CONFLICT
    );
    input["membership_months"] = serde_json::json!(0);
    assert_eq!(
        request(&s, "POST", path, input.clone()).await.0,
        StatusCode::BAD_REQUEST
    );
    input["category"] = serde_json::json!("daily");
    input["membership_months"] = serde_json::json!(4);
    assert_eq!(
        request(&s, "POST", path, input).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn expired_memberships_use_calendar_months_and_ignore_old_renewed_packages() {
    let s = app().await;
    for (key, member, status, at, months) in [
        (
            "expiry-old",
            "Hội viên hết hạn",
            "paid",
            "2024-01-30T18:00:00Z",
            1,
        ),
        (
            "expiry-renewal-old",
            "Hội viên đã gia hạn",
            "paid",
            "2024-01-31T00:00:00Z",
            1,
        ),
        (
            "expiry-renewal-new",
            "hội viên đã gia hạn",
            "paid",
            "2024-02-20T00:00:00Z",
            12,
        ),
        (
            "expiry-pending",
            "Hội viên chờ",
            "pending",
            "2024-01-31T00:00:00Z",
            1,
        ),
    ] {
        let mut input = payment(key, status, 100000, at);
        input["member"] = serde_json::json!(member);
        input["membership_months"] = serde_json::json!(months);
        assert_eq!(
            request(&s, "POST", "/api/transactions", input).await.0,
            StatusCode::OK
        );
    }

    let february_28 = NaiveDate::from_ymd_opt(2024, 2, 28).unwrap();
    let february_29 = NaiveDate::from_ymd_opt(2024, 2, 29).unwrap();
    assert!(
        expired_memberships(&s.db, None, february_28)
            .await
            .unwrap()
            .is_empty()
    );
    let expired = expired_memberships(&s.db, None, february_29).await.unwrap();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].payment.member, "Hội viên hết hạn");
    assert_eq!(expired[0].expires_on, Some(february_29));

    let (_, overview) = request(
        &s,
        "GET",
        "/api/overview?expired_memberships=true&from=2026-01-01&status=pending&q=gia",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(overview["expired_memberships"], true);
    assert_eq!(overview["gross"], 0);
    assert_eq!(overview["total"], 1);
    assert_eq!(overview["items"][0]["expires_on"], "2025-02-20");
}

#[tokio::test]
async fn partial_refund_retry_over_refund_and_cross_period() {
    let s = app().await;
    let (_, p) = request(
        &s,
        "POST",
        "/api/transactions",
        payment(
            "refund-payment-key",
            "paid",
            900000,
            "2026-01-01T09:00:00+07:00",
        ),
    )
    .await;
    let path = format!("/api/transactions/{}/refunds", p["id"].as_str().unwrap());
    let r = serde_json::json!({"amount":300000,"reason":"Đổi gói tập","idempotency_key":"refund-retry-key"});
    let a = request(&s, "POST", &path, r.clone()).await;
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a.1, request(&s, "POST", &path, r.clone()).await.1);
    let mut changed = r;
    changed["amount"] = serde_json::json!(250000);
    assert_eq!(
        request(&s, "POST", &path, changed).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(request(&s,"POST",&path,serde_json::json!({"amount":600001,"reason":"Vượt số tiền","idempotency_key":"over-refund-key"})).await.0,StatusCode::BAD_REQUEST);
    let (_, v) = request(
        &s,
        "GET",
        &format!(
            "/api/overview?from={}&to={}",
            local_date(&now()).unwrap(),
            local_date(&now()).unwrap()
        ),
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(v["gross"], 0);
    assert_eq!(v["refunded"], 300000);
    assert_eq!(v["net"], -300000);
    assert_eq!(request(&s,"POST",&path,serde_json::json!({"amount":600000,"reason":"Hoàn phần còn lại","idempotency_key":"remaining-refund-key"})).await.0,StatusCode::OK);
    let (_, original_period) = request(
        &s,
        "GET",
        "/api/overview?from=2026-01-01&to=2026-01-01",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(original_period["refunded"], 0);
    assert_eq!(original_period["items"][0]["refunded_amount"], 900000);
}
#[tokio::test]
async fn reject_invalid_amount_dates_and_unauthenticated_requests() {
    let s = app().await;
    assert_eq!(
        request(
            &s,
            "POST",
            "/api/transactions",
            payment("invalid-amount", "paid", -1, "2026-11-01T00:00:00Z")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &s,
            "GET",
            "/api/overview?from=2026-12-01&to=2026-01-01",
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let res = router(s)
        .oneshot(
            Request::builder()
                .uri("/api/export")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn filters_and_pagination_match_export() {
    let s = app().await;
    for i in 0..12 {
        request(
            &s,
            "POST",
            "/api/transactions",
            payment(
                &format!("pagination-key-{i}"),
                "paid",
                125000,
                "2026-11-01T00:00:00Z",
            ),
        )
        .await;
    }
    let (_, v) = request(
        &s,
        "GET",
        "/api/overview?page=2&category=membership&method=transfer",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(v["total"], 12);
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    assert_eq!(v["gross"], 1500000);
    let (status, csv) = request(
        &s,
        "GET",
        "/api/export?category=membership&method=transfer",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(csv.as_str().unwrap().lines().count(), 13);
}
#[test]
fn csv_quotes_and_formula_injection() {
    assert_eq!(cell("=SUM(A1)"), "\"'=SUM(A1)\"");
    assert_eq!(cell("Tên, \"A\""), "\"Tên, \"\"A\"\"\"");
}

#[tokio::test]
async fn daily_income_sums_sources_after_combined_category_and_method_filters() {
    let s = app().await;
    for (i, category, method, amount, status, at) in [
        (
            0,
            "membership",
            "cash",
            100000,
            "paid",
            "2026-11-25T01:00:00Z",
        ),
        (
            1,
            "membership",
            "cash",
            200000,
            "paid",
            "2026-11-25T02:00:00Z",
        ),
        (2, "pt", "cash", 300000, "paid", "2026-11-25T03:00:00Z"),
        (
            3,
            "class",
            "transfer",
            400000,
            "paid",
            "2026-11-25T04:00:00Z",
        ),
        (
            4,
            "membership",
            "cash",
            50000,
            "pending",
            "2026-11-25T05:00:00Z",
        ),
        (
            5,
            "membership",
            "cash",
            70000,
            "paid",
            "2026-11-25T17:00:00Z",
        ),
    ] {
        let mut body = payment(&format!("daily-filter-test-{i}"), status, amount, at);
        body["category"] = category.into();
        body["method"] = method.into();
        assert_eq!(
            request(&s, "POST", "/api/transactions", body).await.0,
            StatusCode::OK
        );
    }
    for (filter, expected) in [
        ("", 1000000),
        ("&method=cash", 600000),
        ("&category=membership", 300000),
        ("&category=membership&method=cash", 300000),
        ("&category=pt&method=cash", 300000),
        ("&category=class&method=transfer", 400000),
    ] {
        let (_, result) = request(
            &s,
            "GET",
            &format!("/api/overview?from=2026-11-25&to=2026-11-25{filter}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(result["daily"].as_array().unwrap().len(), 1, "{filter}");
        assert_eq!(result["daily"][0]["date"], "2026-11-25");
        assert_eq!(result["daily"][0]["income"], expected, "{filter}");
        assert_eq!(result["gross"], expected, "{filter}");
    }
}

#[tokio::test]
async fn settling_pending_records_actual_payment_date_once() {
    let s = app().await;
    let original = payment(
        "settle-pending-key",
        "pending",
        450000,
        "2026-01-01T00:00:00Z",
    );
    let (_, p) = request(&s, "POST", "/api/transactions", original.clone()).await;
    let path = format!("/api/transactions/{}/settle", p["id"].as_str().unwrap());
    assert_eq!(
        request(&s, "POST", &path, serde_json::Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&s, "POST", &path, serde_json::Value::Null).await.0,
        StatusCode::OK
    );
    let (_, v) = request(
        &s,
        "GET",
        &format!(
            "/api/overview?from={}&to={}",
            local_date(&now()).unwrap(),
            local_date(&now()).unwrap()
        ),
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(v["gross"], 450000);
    assert_eq!(
        request(&s, "POST", "/api/transactions", original).await,
        (StatusCode::OK, p)
    );
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action='payment_settled'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn future_payments_must_not_be_marked_paid() {
    let s = app().await;
    let future = (Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    for (status, expected) in [
        ("paid", StatusCode::BAD_REQUEST),
        ("pending", StatusCode::OK),
    ] {
        let result = request(
            &s,
            "POST",
            "/api/transactions",
            payment("future-payment", status, 50000, &future),
        )
        .await;
        assert_eq!(result.0, expected);
    }
}

#[tokio::test]
async fn reports_require_canonical_bounds_and_handle_invalid_stored_dates() {
    let s = app().await;
    let (status, created) = request(
        &s,
        "POST",
        "/api/transactions",
        payment("legacy-date-fixture", "paid", 50000, "2026-01-03T00:00:00Z"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("UPDATE transactions SET occurred_at = 'invalid' WHERE id = ?")
        .bind(created["id"].as_str().unwrap())
        .execute(&s.db)
        .await
        .unwrap();
    for endpoint in ["/api/overview", "/api/export"] {
        let invalid = format!("{endpoint}?from=2026-1-2&to=2026-01-31");
        assert_eq!(
            request(&s, "GET", &invalid, serde_json::Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&s, "GET", endpoint, serde_json::Value::Null)
                .await
                .0,
            StatusCode::OK
        );
    }
    let (_, overview) = request(&s, "GET", "/api/overview", serde_json::Value::Null).await;
    assert_eq!(overview["gross"], 0);
}

#[tokio::test]
async fn concurrent_refunds_cannot_exceed_original_payment() {
    let s = app().await;
    let (_, p) = request(
        &s,
        "POST",
        "/api/transactions",
        payment(
            "concurrent-refund-key",
            "paid",
            900000,
            "2026-11-01T00:00:00Z",
        ),
    )
    .await;
    let path = format!("/api/transactions/{}/refunds", p["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        request(
            &s,
            "POST",
            &path,
            serde_json::json!({"amount":600000,"reason":"Hoàn 1","idempotency_key":"concurrent-refund-a"})
        ),
        request(
            &s,
            "POST",
            &path,
            serde_json::json!({"amount":600000,"reason":"Hoàn 2","idempotency_key":"concurrent-refund-b"})
        )
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::BAD_REQUEST)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::BAD_REQUEST)
    );
    let sum: i64 = sqlx::query_scalar("SELECT SUM(amount) FROM refunds")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(sum, 600000);
}
