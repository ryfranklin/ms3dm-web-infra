output "function_url" {
  description = "POST endpoint for the contact form. Set this as REACT_APP_CONTACT_ENDPOINT (public/env.js)."
  value       = aws_lambda_function_url.mailer.function_url
}

output "function_name" {
  description = "Name of the mailer Lambda."
  value       = aws_lambda_function.mailer.function_name
}

output "ses_identities" {
  description = "SES email identities created (each must be verified via the email SES sends before delivery works)."
  value       = [for i in aws_sesv2_email_identity.this : i.email_identity]
}

output "log_group" {
  description = "CloudWatch log group for the Lambda."
  value       = aws_cloudwatch_log_group.lambda.name
}
