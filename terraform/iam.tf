data "aws_region" "current" {}

# --- Execution role ---

data "aws_iam_policy_document" "assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

# Allow the function to write its own logs to the dedicated log group.
# NodejsFunction attaches this implicitly via the managed basic-execution role;
# we scope it to the specific log group instead.
data "aws_iam_policy_document" "logs" {
  statement {
    sid    = "WriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "logs"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.logs.json
}

# --- Least privilege: the only real AWS call the app makes is Textract
# DetectDocumentText. Grant that single action and nothing else. ---
data "aws_iam_policy_document" "textract" {
  statement {
    sid       = "TextractDetectDocumentText"
    effect    = "Allow"
    actions   = ["textract:DetectDocumentText"]
    resources = ["*"] # DetectDocumentText is not resource-scoped.
  }
}

resource "aws_iam_role_policy" "textract" {
  name   = "textract"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.textract.json
}

# --- Optional: grant Bedrock InvokeModel on the configured model only, for
# when the mock summarizer is swapped for a real Bedrock implementation. ---
data "aws_iam_policy_document" "bedrock" {
  count = var.grant_bedrock_invoke ? 1 : 0

  statement {
    sid       = "BedrockInvokeModel"
    effect    = "Allow"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${data.aws_region.current.region}::foundation-model/${var.bedrock_model_id}"]
  }
}

resource "aws_iam_role_policy" "bedrock" {
  count  = var.grant_bedrock_invoke ? 1 : 0
  name   = "bedrock"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.bedrock[0].json
}

# --- Log group: explicit, short retention to avoid unbounded log storage cost.
# The name must match the Lambda's default log group so the function writes here. ---
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = 7
}
