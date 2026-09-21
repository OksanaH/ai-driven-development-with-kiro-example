# Optional cost guardrail: a monthly budget with an alert at 80% actual spend.
# Purely observational — it never blocks usage. Created only when
# monthly_budget_usd is set; the notification is attached only when an alert
# email is provided
resource "aws_budgets_budget" "monthly" {
  count = var.monthly_budget_usd == null ? 0 : 1

  name         = "${var.function_name}-monthly-cost"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"

  dynamic "notification" {
    for_each = var.budget_alert_email == null ? [] : [var.budget_alert_email]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = 80
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [notification.value]
    }
  }
}
