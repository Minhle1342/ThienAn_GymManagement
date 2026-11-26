use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::{collections::VecDeque, sync::Mutex};
use tower::ServiceExt;

async fn app() -> App {
    let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!().run(&db).await.unwrap();
    crate::add_admin(&db, "assistant-test-code").await.unwrap();
    App { db }
}

async fn payment(db: &SqlitePool, id: &str, status: &str, at: &str, amount: i64) {
    sqlx::query("INSERT INTO transactions(id,member,description,category,method,amount,status,occurred_at,idempotency_key) VALUES(?, 'Tên riêng', 'Thông tin riêng', 'membership', 'cash', ?, ?, ?, ?)")
        .bind(id).bind(amount).bind(status).bind(at).bind(id).execute(db).await.unwrap();
}

fn request(uri: &str, body: Value, authorized: bool) -> Request<Body> {
    let mut request = Request::builder().uri(uri);
    if authorized {
        request = request.header("authorization", "Bearer assistant-test-code");
    }
    if !body.is_null() {
        request = request
            .method("POST")
            .header("content-type", "application/json");
    }
    request.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn tools_match_dashboard_for_local_date_boundary_and_cross_period_refund() {
    let app = app().await;
    payment(&app.db, "TA-previous", "paid", "2026-11-24T16:59:59Z", 1000).await;
    payment(&app.db, "TA-start", "paid", "2026-11-24T17:00:00Z", 500).await;
    payment(
        &app.db,
        "TA-pending",
        "pending",
        "2026-11-25T06:00:00Z",
        900,
    )
    .await;
    payment(&app.db, "TA-end", "paid", "2026-11-25T17:00:00Z", 300).await;
    sqlx::query("INSERT INTO refunds VALUES('refund-one','TA-previous',200,'Thông tin riêng','2026-11-25T03:00:00Z','refund-one')")
        .execute(&app.db).await.unwrap();
    let range =
        json!({"from":"2026-11-25","to":"2026-11-25","category":"membership","method":"cash"});
    let totals = tools::execute(&app.db, "summarize_income", range.clone())
        .await
        .unwrap();
    let response = crate::router(app.clone())
        .oneshot(request(
            "/api/overview?from=2026-11-25&to=2026-11-25&category=membership&method=cash",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let dashboard: Value = serde_json::from_slice(&body).unwrap();
    for field in ["gross", "refunded", "net"] {
        assert_eq!(totals["rows"][0][field], dashboard[field]);
    }
    assert_eq!(totals["rows"][0]["paid_count"], dashboard["count"]);
    assert_eq!(totals["rows"][0]["net"], 300);
    let mut weekly = range.clone();
    weekly["group_by"] = json!("week");
    let groups = tools::execute(&app.db, "breakdown_income", weekly)
        .await
        .unwrap();
    assert_eq!(groups["rows"][0]["bucket"], "2026-11-23");
    let refunds = tools::execute(&app.db, "search_refunds", range)
        .await
        .unwrap();
    assert_eq!(refunds["rows"][0]["transaction_id"], "TA-previous");
    let detail = tools::execute(
        &app.db,
        "get_transaction",
        json!({"transaction_id":"TA-previous"}),
    )
    .await
    .unwrap();
    assert_eq!(detail["refunded"], 200);
    assert!(!detail.to_string().contains("riêng"));
}

#[tokio::test]
async fn cursor_handles_tied_timestamps_and_rejects_unbounded_or_untrusted_queries() {
    let app = app().await;
    for i in 0..45 {
        payment(
            &app.db,
            &format!("TA-{i:02}"),
            "paid",
            "2026-11-25T08:00:00Z",
            500,
        )
        .await;
    }
    let mut filters = json!({"from":"2026-11-25","to":"2026-11-25"});
    let mut ids = std::collections::HashSet::new();
    for size in [20, 20, 5] {
        let page = tools::execute(&app.db, "search_transactions", filters.clone())
            .await
            .unwrap();
        let rows = page["rows"].as_array().unwrap();
        assert_eq!(rows.len(), size);
        for row in rows {
            assert!(ids.insert(row["id"].as_str().unwrap().to_owned()));
        }
        filters["cursor"] = page["next_cursor"].clone();
    }
    assert!(filters["cursor"].is_null());
    assert!(
        tools::execute(
            &app.db,
            "run_sql",
            json!({"sql":"DELETE FROM transactions"})
        )
        .await
        .is_err()
    );
    assert!(
        tools::execute(
            &app.db,
            "search_transactions",
            json!({"from":"2024-01-01","to":"2026-11-25"})
        )
        .await
        .is_err()
    );
    assert!(
        tools::execute(
            &app.db,
            "search_transactions",
            json!({"from":"2026-11-25","to":"2026-11-25","method":"unsupported"})
        )
        .await
        .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM transactions")
            .fetch_one(&app.db)
            .await
            .unwrap(),
        45
    );
}

#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Result<Value, &'static str>>>,
    requests: Mutex<Vec<Value>>,
}

impl Provider for Fake {
    fn turn(
        &self,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + '_>> {
        self.requests.lock().unwrap().push(input);
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err("Unexpected provider call"));
        Box::pin(async move { reply })
    }
}

fn service(provider: Arc<dyn Provider>) -> Service {
    Service {
        allow_data: true,
        provider: Some(provider),
        slots: Arc::new(Semaphore::new(3)),
    }
}

fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"function_call","id":id,"name":name,"arguments":args})
}

const CHAT: &str = "/api/assistant/chat";

#[test]
fn gemini_reports_inactive_linked_account() {
    let response = br#"{"error":{"details":[{"reason":"ACCOUNT_STATE_INVALID"}]}}"#;
    assert!(gemini_access_error(401, response).contains("ACCOUNT_STATE_INVALID"));
}

#[test]
fn gemini_reports_google_authentication_reason() {
    let response = br#"{"error":{"details":[{"reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}]}}"#;
    assert!(gemini_access_error(401, response).contains("ACCESS_TOKEN_TYPE_UNSUPPORTED"));
}

#[test]
fn gemini_access_errors_distinguish_key_and_project_failures() {
    let invalid = br#"{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}"#;
    assert!(gemini_access_error(400, invalid).contains("không hợp lệ"));
    let blocked = br#"{"error":{"details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}"#;
    assert!(gemini_access_error(403, blocked).contains("Generative Language API"));
    assert!(gemini_access_error(403, b"{}").contains("trạng thái dự án"));
    assert!(gemini_access_error(401, b"not json").contains("(401)"));
}

#[test]
fn browser_key_accepts_authorization_key_with_dot() {
    let mut headers = HeaderMap::new();
    let key = "AQ.fake-gemini-authorization-key";
    headers.insert("x-thien-an-gemini-key", key.parse().unwrap());
    assert_eq!(browser_key(&headers), Ok(Some(key)));
}

#[tokio::test]
async fn browser_api_key_is_validated_after_authentication() {
    let fake = Arc::new(Fake::default());
    let router = crate::router(app().await).layer(Extension(service(fake.clone())));
    for (authorized, status) in [
        (false, StatusCode::UNAUTHORIZED),
        (true, StatusCode::BAD_REQUEST),
    ] {
        let mut req = request(CHAT, json!({"message":"Tổng thu"}), authorized);
        req.headers_mut()
            .insert("x-thien-an-gemini-key", "bad key".parse().unwrap());
        assert_eq!(router.clone().oneshot(req).await.unwrap().status(), status);
    }
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn data_opt_in_is_required_for_either_provider() {
    let fake = Arc::new(Fake::default());
    let mut disabled = service(fake.clone());
    disabled.allow_data = false;
    let router = crate::router(app().await).layer(Extension(disabled));
    for with_browser_key in [false, true] {
        let mut req = request(CHAT, json!({"message":"Tổng thu"}), true);
        if with_browser_key {
            req.headers_mut().insert(
                "x-thien-an-gemini-key",
                "AQ.fake-gemini-authorization-key".parse().unwrap(),
            );
        }
        let response = router.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            std::str::from_utf8(&body)
                .unwrap()
                .contains("THIEN_AN_AI_ALLOW_DATA=true")
        );
    }
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn authenticated_loop_expands_and_pairs_multiple_calls_with_their_ids() {
    let app = app().await;
    payment(&app.db, "TA-one", "paid", "2026-11-25T08:00:00Z", 500).await;
    let fake = Arc::new(Fake::default());
    let thought = json!({"type":"thought","signature":"signed-opaque"});
    fake.replies.lock().unwrap().extend([
        Ok(json!({"status":"requires_action","steps":[thought, call("a","expand_tools",json!({}))]})),
        Ok(json!({"status":"requires_action","steps":[
            call("b", "get_transaction", json!({"transaction_id":"TA-one"})),
            call("c", "search_refunds", json!({"from":"2026-11-25","to":"2026-11-25"})),
            call("d", "unregistered", json!({})),
            call("e", "search_transactions", json!({"bad":"args"}))
        ]})),
        Ok(json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Đã thu 500 VND."}]}]})),
    ]);
    let router = crate::router(app.clone()).layer(Extension(service(fake.clone())));
    let input = json!({"message":"Tổng đã thu bao nhiêu?"});
    let unauthorized = router
        .clone()
        .oneshot(request(CHAT, input.clone(), false))
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert!(fake.requests.lock().unwrap().is_empty());
    let response = router
        .clone()
        .oneshot(request(CHAT, input.clone(), true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let sse = std::str::from_utf8(&body).unwrap();
    assert!(sse.contains("event: done") && sse.contains("Đã thu 500 VND."));
    assert_eq!(sse.matches("event: tool_start").count(), 5);
    assert_eq!(sse.matches("event: tool_result").count(), 5);
    assert!(sse.find("event: tool_start").unwrap() < sse.find("event: tool_result").unwrap());
    assert!(sse.rfind("event: tool_result").unwrap() < sse.find("event: done").unwrap());
    {
        let requests = fake.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0]["store"], false);
        assert_eq!(requests[1]["input"][1], thought);
        assert!(
            requests[1]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "get_transaction")
        );
        let final_input = requests[2]["input"].as_array().unwrap();
        let result_for = |id: &str| {
            final_input
                .iter()
                .find(|step| step["call_id"] == id)
                .unwrap()["result"][0]["text"]
                .as_str()
                .unwrap()
        };
        assert!(result_for("b").contains("500"));
        assert!(result_for("c").contains("rows"));
        assert!(result_for("d").contains("không được khai báo"));
        assert!(result_for("e").contains("Tham số không hợp lệ"));
    }
    sqlx::query("UPDATE admin_access_codes SET revoked_at = ?")
        .bind(crate::now())
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        router
            .oneshot(request(CHAT, input, true))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fake.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn missing_config_provider_errors_and_loop_budget_are_reported() {
    let app = app().await;
    let input = json!({"message":"Cho xem giao dịch"});
    assert_eq!(
        crate::router(app.clone())
            .oneshot(request(CHAT, input.clone(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let fake = Arc::new(Fake::default());
    fake.replies
        .lock()
        .unwrap()
        .push_back(Err("Gemini đã đạt hạn mức."));
    for i in 0..MAX_MODEL_CALLS {
        fake.replies.lock().unwrap().push_back(Ok(json!({"steps":[call(&format!("call-{i}"), "get_transaction", json!({"transaction_id":"TA-none"}))]})));
    }
    let router = crate::router(app).layer(Extension(service(fake.clone())));
    for message in ["Gemini đã đạt hạn mức.", BUDGET] {
        let response = router
            .clone()
            .oneshot(request(CHAT, input.clone(), true))
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let sse = std::str::from_utf8(&body).unwrap();
        assert!(sse.contains("event: error") && sse.contains(message));
    }
    assert_eq!(fake.requests.lock().unwrap().len(), MAX_MODEL_CALLS + 1);
}

struct Slow {
    started: tokio::sync::Notify,
    cancelled: Arc<tokio::sync::Notify>,
}
struct Cancelled(Arc<tokio::sync::Notify>);
impl Drop for Cancelled {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}
impl Provider for Slow {
    fn turn(
        &self,
        _: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + '_>> {
        Box::pin(async {
            let _guard = Cancelled(self.cancelled.clone());
            self.started.notify_one();
            std::future::pending().await
        })
    }
}

#[tokio::test]
async fn disconnect_drops_provider_future() {
    let slow = Arc::new(Slow {
        started: tokio::sync::Notify::new(),
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let response = crate::router(app().await)
        .layer(Extension(service(slow.clone())))
        .oneshot(request(CHAT, json!({"message":"Tổng tháng này"}), true))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), slow.started.notified())
        .await
        .unwrap();
    drop(response);
    tokio::time::timeout(Duration::from_secs(2), slow.cancelled.notified())
        .await
        .unwrap();
}
