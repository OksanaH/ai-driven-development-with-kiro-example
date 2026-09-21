provider "aws" {
  region = var.aws_region

  # Applied to every taggable resource
  default_tags {
    tags = {
      Project   = "text-summary-extractor"
      ManagedBy = "Terraform"
    }
  }
}
