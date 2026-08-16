# Remote state for the bootstrap stack (separate key from the contact stack).
# Uses the same state bucket and lock table (see ../BOOTSTRAP.md).
terraform {
  backend "s3" {
    bucket         = "ms3dm-web-tfstate"
    key            = "bootstrap/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ms3dm-web-tflock"
    encrypt        = true
  }
}
