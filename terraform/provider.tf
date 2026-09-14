provider "aws" {
  region = var.aws_region

  # Applied to every taggable resource, mirroring a sensible CDK default.
  default_tags {
    tags = {
      Project   = "text-summary-extractor"
      ManagedBy = "Terraform"
    }
  }
}
