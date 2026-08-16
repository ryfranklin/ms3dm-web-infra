variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "github_owner" {
  description = "GitHub owner/org that hosts the repo allowed to assume the CI role."
  type        = string
  default     = "ryfranklin"
}

variable "github_repo" {
  description = "GitHub repository allowed to assume the CI role."
  type        = string
  default     = "ms3dm-web-infra"
}

variable "role_name" {
  description = "Name of the GitHub Actions OIDC role."
  type        = string
  default     = "github-actions-ms3dm-web-infra"
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    Project = "ms3dm.tech"
    Purpose = "ci-oidc"
  }
}
