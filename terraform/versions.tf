terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64" # Latest at time of writing (from Terraform Registry)
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8" # Zips the bundled Lambda handler
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.3" # Runs esbuild via local-exec
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5" # Copies the frontend asset into the Lambda bundle
    }
  }
}
