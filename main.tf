terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Provider Configuration (Must be us-east-1 for CloudFront/ACM)
provider "aws" {
  region  = "us-east-1"
  profile = "thomasbunke"
}

# --- Variables ---
variable "domain_name" {
  default = "beijaflorsolutions.com"
}

variable "bucket_name" {
  default = "beijaflorsolutions-website-content"
}

variable "sender_email" {
  default = "noreply@beijaflorsolutions.com"
}

variable "deepseek_api_key" {
  description = "DeepSeek API key for LLM chat"
  type        = string
  sensitive   = true
}

# --- Route 53 Zone (shared by frontend and backend) ---
resource "aws_route53_zone" "main" {
  name = var.domain_name
}
