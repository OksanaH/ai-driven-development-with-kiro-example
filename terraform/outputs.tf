output "web_app_url" {
  description = "Public HTTPS URL of the Text Summary Extractor web app."
  value       = aws_lambda_function_url.web_app.function_url
}

output "function_name" {
  description = "Name of the web app Lambda function."
  value       = aws_lambda_function.web_app.function_name
}
