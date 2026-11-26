use chrono::{Days, FixedOffset, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

const PAGE_SIZE: i64 = 20;
const TOOL_NAMES: [&str; 5] = [
    "summarize_income",
    "breakdown_income",
    "search_transactions",
    "get_transaction",
    "search_refunds",
];

fn declaration(name: &str) -> Value {
    let date =
        || json!({"type":"string", "description":"Ngày Việt Nam, YYYY-MM-DD, tính cả ngày biên"});
    let id = || json!({"type":"string", "description":"Mã phiếu giao dịch"});
    let mut fields = json!({
        "from":date(), "to":date(),
        "category":{"type":"string","enum":crate::INCOME_CATEGORIES},
        "method":{"type":"string","enum":["cash","transfer","card"]}
    });
    let mut required = vec!["from", "to"];
    let description = match name {
        "summarize_income" => "Tổng tiền đã thu, hoàn, ròng và số giao dịch thành công trong kỳ.",
        "breakdown_income" => {
            fields["group_by"] =
                json!({"type":"string","enum":["day","week","month","category","method"]});
            required.push("group_by");
            "Tổng tiền thu, hoàn và ròng theo nhóm. Dùng tuần/tháng cho kỳ dài."
        }
        "get_transaction" => {
            fields = json!({"transaction_id":id()});
            required = vec!["transaction_id"];
            "Xem một giao dịch theo mã phiếu, tổng đã hoàn và các lần hoàn gần nhất."
        }
        "search_transactions" | "search_refunds" => {
            fields["transaction_id"] = id();
            fields["status"] = json!({"type":"string","enum":["paid","pending","failed"]});
            fields["cursor"] = json!({"type":"object","properties":{
                "at":{"type":"string"}, "id":{"type":"string"}
            },"required":["at","id"]});
            if name == "search_transactions" {
                "Danh sách giao dịch theo kỳ và bộ lọc. Dùng next_cursor nguyên vẹn để xem tiếp."
            } else {
                "Danh sách hoàn tiền theo ngày hoàn và thuộc tính phiếu gốc. Dùng next_cursor nguyên vẹn để xem tiếp."
            }
        }
        _ => unreachable!(),
    };
    json!({"type":"function","name":name,"description":description,
        "parameters":{"type":"object","properties":fields,"required":required}})
}

pub(super) fn declarations(message: &str) -> Vec<Value> {
    let message = message.to_lowercase();
    let lookup = ["mã phiếu", "giao dịch", "chi tiết", "danh sách"]
        .iter()
        .any(|s| message.contains(s));
    let analysis = ["tổng", "bao nhiêu", "doanh thu", "so sánh", "phân bổ"]
        .iter()
        .any(|s| message.contains(s));
    let names = if !lookup && analysis {
        &TOOL_NAMES[..2]
    } else {
        &TOOL_NAMES[..]
    };
    let mut result: Vec<_> = names.iter().map(|name| declaration(name)).collect();
    if names.len() < TOOL_NAMES.len() {
        result.push(json!({"type":"function", "name":"expand_tools",
            "description":"Mở thêm tool tra cứu giao dịch và hoàn tiền nếu cần kiểm tra chi tiết.",
            "parameters":{"type":"object","properties":{}}}));
    }
    result
}

pub(super) fn all_declarations() -> Vec<Value> {
    TOOL_NAMES.iter().map(|name| declaration(name)).collect()
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Group {
    Day,
    Week,
    Month,
    Category,
    Method,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    at: String,
    id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Args {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    category: Option<String>,
    method: Option<String>,
    status: Option<String>,
    transaction_id: Option<String>,
    group_by: Option<Group>,
    cursor: Option<Cursor>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

impl Args {
    fn validate(&self, name: &str) -> Result<(), &'static str> {
        let allowed = |value: &Option<String>, values: &[&str]| {
            value.as_deref().is_none_or(|v| values.contains(&v))
        };
        if !allowed(&self.category, &crate::INCOME_CATEGORIES)
            || !allowed(&self.method, &["cash", "transfer", "card"])
            || !allowed(&self.status, &["paid", "pending", "failed"])
            || self
                .transaction_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
            || self.cursor.as_ref().is_some_and(|c| {
                !valid_id(&c.id) || crate::timestamp(&c.at).ok().as_ref() != Some(&c.at)
            })
        {
            return Err("Giá trị bộ lọc hoặc con trỏ không hợp lệ.");
        }
        let list = matches!(name, "search_transactions" | "search_refunds");
        if (!list && (self.status.is_some() || self.cursor.is_some()))
            || ((name == "breakdown_income") != self.group_by.is_some())
            || (!list && name != "get_transaction" && self.transaction_id.is_some())
        {
            return Err("Tham số không áp dụng cho tool này.");
        }
        if name == "get_transaction"
            && (self.from.is_some()
                || self.to.is_some()
                || self.category.is_some()
                || self.method.is_some())
        {
            return Err("Tra cứu chi tiết chỉ nhận mã phiếu.");
        }
        Ok(())
    }

    fn range(&self) -> Result<(String, String), &'static str> {
        let (Some(from), Some(to)) = (self.from, self.to) else {
            return Err("Cần ngày bắt đầu và ngày kết thúc.");
        };
        let span = (to - from).num_days();
        if !(0..366).contains(&span) || !(1900..=9998).contains(&chrono::Datelike::year(&from)) {
            return Err("Chọn kỳ từ 1 đến 366 ngày.");
        }
        if matches!(self.group_by, Some(Group::Day)) && span >= 92 {
            return Err("Chọn tối đa 92 ngày để nhóm theo ngày, hoặc chuyển sang tuần/tháng.");
        }
        let end = to
            .checked_add_days(Days::new(1))
            .ok_or("Ngày kết thúc không hợp lệ.")?;
        let local = FixedOffset::east_opt(7 * 3600).unwrap();
        let utc = |day: NaiveDate| {
            local
                .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
                .unwrap()
                .with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        };
        Ok((utc(from), utc(end)))
    }

    fn bind_filters(&self, q: &mut QueryBuilder<'_, Sqlite>) {
        for (column, value) in [
            ("t.category", &self.category),
            ("t.method", &self.method),
            ("t.status", &self.status),
            ("t.id", &self.transaction_id),
        ] {
            if let Some(value) = value {
                q.push(" AND ")
                    .push(column)
                    .push(" = ")
                    .push_bind(value.clone());
            }
        }
    }
}

#[derive(sqlx::FromRow, Serialize)]
struct Entry {
    id: String,
    transaction_id: String,
    category: String,
    method: String,
    status: String,
    amount: i64,
    at: String,
}

#[derive(sqlx::FromRow, Serialize)]
struct Total {
    bucket: String,
    gross: i64,
    refunded: i64,
    net: i64,
    paid_count: i64,
}

fn bounds(q: &mut QueryBuilder<'_, Sqlite>, column: &str, range: &(String, String)) {
    q.push(column)
        .push(" >= ")
        .push_bind(range.0.clone())
        .push(" AND ")
        .push(column)
        .push(" < ")
        .push_bind(range.1.clone());
}

async fn totals(
    db: &SqlitePool,
    args: &Args,
    range: &(String, String),
) -> Result<Value, sqlx::Error> {
    // Each row contributes once. Refund dates come from the refund, not the original payment.
    let mut q = QueryBuilder::new(
        "WITH cashflow AS (SELECT t.category,t.method,t.occurred_at AS at,t.amount AS income,0 AS refund,1 AS paid FROM transactions t WHERE t.status='paid' AND ",
    );
    bounds(&mut q, "t.occurred_at", range);
    args.bind_filters(&mut q);
    q.push(" UNION ALL SELECT t.category,t.method,r.occurred_at,0,r.amount,0 FROM refunds r JOIN transactions t ON t.id=r.transaction_id WHERE ");
    bounds(&mut q, "r.occurred_at", range);
    args.bind_filters(&mut q);
    let bucket = match args.group_by {
        None => "'all'",
        Some(Group::Day) => "date(at,'+7 hours')",
        Some(Group::Week) => "date(at,'+7 hours','-6 days','weekday 1')",
        Some(Group::Month) => "strftime('%Y-%m',at,'+7 hours')",
        Some(Group::Category) => "category",
        Some(Group::Method) => "method",
    };
    q.push(") SELECT ").push(bucket)
        .push(" AS bucket, COALESCE(SUM(income),0) AS gross, COALESCE(SUM(refund),0) AS refunded, COALESCE(SUM(income-refund),0) AS net, COALESCE(SUM(paid),0) AS paid_count FROM cashflow");
    if args.group_by.is_some() {
        q.push(" GROUP BY 1 ORDER BY 1");
    }
    let rows = q.build_query_as::<Total>().fetch_all(db).await?;
    Ok(
        json!({"rows":rows, "from":args.from, "to":args.to, "currency":"VND", "timezone":"Asia/Ho_Chi_Minh"}),
    )
}

async fn entries(
    db: &SqlitePool,
    args: &Args,
    range: &(String, String),
    refunds: bool,
) -> Result<Value, sqlx::Error> {
    let (sql, time_column, id_column) = if refunds {
        (
            "SELECT r.id,t.id AS transaction_id,t.category,t.method,t.status,r.amount,r.occurred_at AS at FROM refunds r JOIN transactions t ON t.id=r.transaction_id WHERE ",
            "r.occurred_at",
            "r.id",
        )
    } else {
        (
            "SELECT t.id,t.id AS transaction_id,t.category,t.method,t.status,t.amount,t.occurred_at AS at FROM transactions t WHERE ",
            "t.occurred_at",
            "t.id",
        )
    };
    let mut q = QueryBuilder::new(sql);
    bounds(&mut q, time_column, range);
    args.bind_filters(&mut q);
    if let Some(cursor) = &args.cursor {
        q.push(" AND (")
            .push(time_column)
            .push(", ")
            .push(id_column)
            .push(") < (")
            .push_bind(cursor.at.clone())
            .push(", ")
            .push_bind(cursor.id.clone())
            .push(")");
    }
    q.push(" ORDER BY ")
        .push(time_column)
        .push(" DESC, ")
        .push(id_column)
        .push(" DESC LIMIT ")
        .push_bind(PAGE_SIZE + 1);
    let mut rows = q.build_query_as::<Entry>().fetch_all(db).await?;
    let more = rows.len() > PAGE_SIZE as usize;
    rows.truncate(PAGE_SIZE as usize);
    let next = rows.last().filter(|_| more).map(|row| Cursor {
        at: row.at.clone(),
        id: row.id.clone(),
    });
    Ok(json!({"rows":rows, "next_cursor":next, "from":args.from, "to":args.to, "currency":"VND"}))
}

async fn detail(db: &SqlitePool, id: &str) -> Result<Value, sqlx::Error> {
    let mut snapshot = db.begin().await?;
    let payment = sqlx::query_as::<_, Entry>("SELECT id,id AS transaction_id,category,method,status,amount,occurred_at AS at FROM transactions WHERE id=?")
        .bind(id).fetch_optional(&mut *snapshot).await?;
    let Some(payment) = payment else {
        return Ok(json!({"found":false}));
    };
    let refunded: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(amount),0) FROM refunds WHERE transaction_id=?")
            .bind(id)
            .fetch_one(&mut *snapshot)
            .await?;
    let mut refunds: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT id,amount,occurred_at FROM refunds WHERE transaction_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?"
    ).bind(id).bind(PAGE_SIZE + 1).fetch_all(&mut *snapshot).await?;
    snapshot.commit().await?;
    let more = refunds.len() > PAGE_SIZE as usize;
    refunds.truncate(PAGE_SIZE as usize);
    let refunds: Vec<_> = refunds
        .into_iter()
        .map(|(id, amount, at)| json!({"id":id,"amount":amount,"at":at}))
        .collect();
    Ok(
        json!({"found":true,"payment":payment,"refunds":refunds,"refunds_truncated":more,"refunded":refunded,"currency":"VND"}),
    )
}

pub(super) async fn execute(
    db: &SqlitePool,
    name: &str,
    value: Value,
) -> Result<Value, &'static str> {
    if !TOOL_NAMES.contains(&name) {
        return Err("Tool không được phép.");
    }
    let args: Args = serde_json::from_value(value).map_err(|_| "Tham số không hợp lệ.")?;
    args.validate(name)?;
    let result = if name == "get_transaction" {
        detail(db, args.transaction_id.as_deref().ok_or("Cần mã phiếu.")?).await
    } else {
        let range = args.range()?;
        match name {
            "summarize_income" | "breakdown_income" => totals(db, &args, &range).await,
            "search_transactions" | "search_refunds" => {
                entries(db, &args, &range, name == "search_refunds").await
            }
            _ => unreachable!(),
        }
    };
    result.map_err(|_| "Không thể đọc dữ liệu cho yêu cầu này.")
}
