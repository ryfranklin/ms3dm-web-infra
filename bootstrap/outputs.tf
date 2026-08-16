output "role_arn" {
  description = "Set this as the GitHub Actions repo secret AWS_ROLE_ARN."
  value       = aws_iam_role.ci.arn
}

output "oidc_provider_arn" {
  description = "The GitHub Actions OIDC provider ARN."
  value       = aws_iam_openid_connect_provider.github.arn
}
