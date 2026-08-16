variable "aws_region" {
  description = "AWS region for the contact backend (SES must be available here)."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for resource names (hyphenated, no spaces)."
  type        = string
  default     = "ms3dm-contact"
}

variable "from_address" {
  description = "Verified SES From address the message is sent from."
  type        = string
}

variable "to_address" {
  description = "Recipient of contact messages (the site owner)."
  type        = string
}

variable "allowed_origins" {
  description = "Site origins allowed to call the Function URL (CORS)."
  type        = list(string)
  default     = ["https://ms3dm.tech", "https://www.ms3dm.tech"]
}

variable "create_ses_identities" {
  description = "Create SES email identities for the From and To addresses. Set false if they are already verified (for example via a domain identity)."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda log group."
  type        = number
  default     = 30
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds."
  type        = number
  default     = 10
}

variable "lambda_memory" {
  description = "Lambda memory in MB."
  type        = number
  default     = 256
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    Project = "ms3dm.tech"
    Purpose = "contact-form-mail"
  }
}
