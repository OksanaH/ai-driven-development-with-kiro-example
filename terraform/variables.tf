variable "aws_region" {
  description = "AWS region to deploy into. Textract is available in all standard regions."
  type        = string
  default     = "us-east-1"
}

variable "function_name" {
  description = "Name of the web app Lambda function."
  type        = string
  default     = "text-summary-extractor-web-app"
}

# --- Application configuration (passed to the Lambda as env vars) ---

variable "max_input_size_bytes" {
  description = "Upper bound on a single upload, in bytes."
  type        = number
  default     = 10485760 # 10 MB
}

variable "max_summarizer_input_bytes" {
  description = "Truncation ceiling, in bytes, for the summarizer input."
  type        = number
  default     = 100000
}

variable "summarizer_timeout_ms" {
  description = "Summarizer invocation timeout, in milliseconds."
  type        = number
  default     = 30000
}

variable "bedrock_model_id" {
  description = "Foundation model id retained for a future real Bedrock summarizer."
  type        = string
  default     = "anthropic.claude-3-haiku-20240307-v1:0"
}

variable "grant_bedrock_invoke" {
  description = "Grant bedrock:InvokeModel on bedrock_model_id. Leave false while the summarizer is the local mock."
  type        = bool
  default     = false
}

# --- Cost guardrail ---

variable "monthly_budget_usd" {
  description = "Optional monthly budget, in USD. Set to null to skip creating a budget."
  type        = number
  default     = 5
}

variable "budget_alert_email" {
  description = "Optional email to receive the budget alert. Leave null to create the budget without a subscriber."
  type        = string
  default     = null
}
