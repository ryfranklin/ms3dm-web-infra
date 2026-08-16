# Remote state for the contact stack. Bucket and lock table must exist first
# (see ../BOOTSTRAP.md). Bucket/table names are not secrets.
terraform {
  backend "s3" {
    bucket         = "ms3dm-web-tfstate"
    key            = "contact/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ms3dm-web-tflock"
    encrypt        = true
  }
}
