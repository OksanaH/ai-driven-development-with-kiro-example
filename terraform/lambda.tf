# The web app compute: a single Node.js Lambda bundled from the handler, which
# in turn imports the existing pipeline modules under ../src.
resource "aws_lambda_function" "web_app" {
  function_name = var.function_name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  memory_size   = 256
  timeout       = 30

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      MAX_INPUT_SIZE_BYTES       = tostring(var.max_input_size_bytes)
      MAX_SUMMARIZER_INPUT_BYTES = tostring(var.max_summarizer_input_bytes)
      SUMMARIZER_TIMEOUT_MS      = tostring(var.summarizer_timeout_ms)
      BEDROCK_MODEL_ID           = var.bedrock_model_id
    }
  }

  # Ensure the log group exists (with our retention) before the function, so
  # Lambda does not auto-create one with infinite retention.
  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.logs,
  ]
}

# A public HTTPS endpoint with no API Gateway. authorization_type NONE keeps the
# POC simple; note the endpoint is publicly reachable. CORS allows the browser
# frontend to POST the upload.
resource "aws_lambda_function_url" "web_app" {
  function_name      = aws_lambda_function.web_app.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST"]
    allow_headers = ["content-type"]
  }
}
