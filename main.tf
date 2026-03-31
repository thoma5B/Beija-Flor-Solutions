terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# 1. Provider Configuration (Must be us-east-1 for CloudFront/ACM)
provider "aws" {
  region  = "us-east-1"
  profile = "thomasbunke"
}

# --- Variables ---
variable "domain_name" {
  default = "beijaflorsolutions.com" # CHANGE THIS to your domain
}

variable "bucket_name" {
  default = "beijaflorsolutions-website-content" # Must be globally unique
}

# --- Backend Variables ---
variable "sender_email" {
  default = "noreply@beijaflorsolutions.com"
}

# --- 2. S3 Bucket (Private) ---
resource "aws_s3_bucket" "website" {
  bucket = var.bucket_name
}

# Block all public access (CloudFront will access via policy)
resource "aws_s3_bucket_public_access_block" "website" {
  bucket = aws_s3_bucket.website.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- 3. Upload Website Content ---
# This uploads everything in the 'website' folder automatically
resource "aws_s3_object" "content" {
  for_each = fileset("${path.module}/beijaflorsolutions/dist", "**")

  bucket = aws_s3_bucket.website.id
  key    = each.value
  source = "${path.module}/beijaflorsolutions/dist/${each.value}"
  etag   = filemd5("${path.module}/beijaflorsolutions/dist/${each.value}")

  # Simple Content-Type detection
  content_type = lookup({
    "html"  = "text/html"
    "css"   = "text/css"
    "js"    = "application/javascript"
    "mjs"   = "application/javascript"
    "json"  = "application/json"
    "png"   = "image/png"
    "jpg"   = "image/jpeg"
    "jpeg"  = "image/jpeg"
    "svg"   = "image/svg+xml"
    "ico"   = "image/x-icon"
    "webp"  = "image/webp"
    "map"   = "application/json"
    "woff2" = "font/woff2"
    "woff"  = "font/woff"
    "ttf"   = "font/ttf"
    "otf"   = "font/otf"
    "txt"   = "text/plain"
  }, split(".", each.value)[length(split(".", each.value)) - 1], "application/octet-stream")
}

# --- 4. Route 53 Zone ---
resource "aws_route53_zone" "main" {
  name = var.domain_name
}

# --- 5. ACM Certificate (HTTPS) ---
resource "aws_acm_certificate" "cert" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  subject_alternative_names = ["www.${var.domain_name}"]

  lifecycle {
    create_before_destroy = true
  }
}

# Create DNS record to validate the certificate
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cert.domain_validation_options : dvo.domain_name => dvo
  }

  allow_overwrite = true
  name            = each.value.resource_record_name
  records         = [each.value.resource_record_value]
  ttl             = 60
  type            = each.value.resource_record_type
  zone_id         = aws_route53_zone.main.zone_id
}

# Wait for validation to succeed
resource "aws_acm_certificate_validation" "cert" {
  certificate_arn         = aws_acm_certificate.cert.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# --- 6. CloudFront Distribution ---
# Create OAC (Origin Access Control) to allow CloudFront to access S3
resource "aws_cloudfront_origin_access_control" "default" {
  name                              = "s3-oac-${var.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "s3_distribution" {
  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "S3-${var.bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.default.id
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name, "www.${var.domain_name}"]

  custom_error_response {
    # Ensure missing object errors return index.html for client-side routing
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${var.bucket_name}"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cert.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# --- 7. S3 Bucket Policy (Allow CloudFront) ---
resource "aws_s3_bucket_policy" "allow_access_from_cloudfront" {
  bucket = aws_s3_bucket.website.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipal"
        Effect    = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.website.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.s3_distribution.arn
          }
        }
      }
    ]
  })
}

# --- 8. Route 53 Alias Record (Point Domain to CloudFront) ---
resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.s3_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.s3_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apex" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.s3_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.s3_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- Backend: DynamoDB Table for Verification Codes ---
resource "aws_dynamodb_table" "verification_codes" {
  name         = "beijaflor-verification-codes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Project = "beijaflorsolutions"
  }
}

# --- Backend: SES Domain Identity ---
resource "aws_ses_domain_identity" "main" {
  domain = var.domain_name
}

resource "aws_route53_record" "ses_verification" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = "_amazonses.${var.domain_name}"
  type            = "TXT"
  ttl             = 600
  records         = [aws_ses_domain_identity.main.verification_token]
  allow_overwrite = false
}

resource "aws_ses_domain_identity_verification" "main" {
  domain     = aws_ses_domain_identity.main.id
  depends_on = [aws_route53_record.ses_verification]
}

# SES DKIM
resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

resource "aws_route53_record" "ses_dkim" {
  count           = 3
  zone_id         = aws_route53_zone.main.zone_id
  name            = "${aws_ses_domain_dkim.main.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type            = "CNAME"
  ttl             = 600
  records         = ["${aws_ses_domain_dkim.main.dkim_tokens[count.index]}.dkim.amazonses.com"]
  allow_overwrite = true
}

# SES Mail From (optional but improves deliverability)
resource "aws_ses_domain_mail_from" "main" {
  domain           = aws_ses_domain_identity.main.domain
  mail_from_domain = "mail.${var.domain_name}"
}

resource "aws_route53_record" "ses_mail_from_mx" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = "mail.${var.domain_name}"
  type            = "MX"
  ttl             = 600
  records         = ["10 feedback-smtp.us-east-1.amazonses.com"]
  allow_overwrite = true
}

resource "aws_route53_record" "ses_mail_from_spf" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = "mail.${var.domain_name}"
  type            = "TXT"
  ttl             = 600
  records         = ["v=spf1 include:amazonses.com -all"]
  allow_overwrite = true
}

# --- Backend: IAM Role for Lambda ---
resource "aws_iam_role" "lambda_auth" {
  name = "beijaflor-auth-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "lambda_auth" {
  name = "beijaflor-auth-lambda-policy"
  role = aws_iam_role.lambda_auth.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem"
        ]
        Resource = aws_dynamodb_table.verification_codes.arn
      }
    ]
  })
}

# --- Backend: Lambda Function ---
data "archive_file" "auth_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/backend/auth"
  output_path = "${path.module}/backend/auth.zip"
}

resource "aws_lambda_function" "auth" {
  filename         = data.archive_file.auth_lambda.output_path
  function_name    = "beijaflor-auth"
  role             = aws_iam_role.lambda_auth.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.auth_lambda.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME   = aws_dynamodb_table.verification_codes.name
      SENDER_EMAIL = var.sender_email
    }
  }

  depends_on = [aws_iam_role_policy.lambda_auth]
}

# --- Backend: API Gateway HTTP API ---
resource "aws_apigatewayv2_api" "auth" {
  name          = "beijaflor-auth-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [
      "https://${var.domain_name}",
      "https://www.${var.domain_name}",
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:8080"
    ]
    allow_methods = ["POST", "OPTIONS"]
    allow_headers = ["Content-Type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_stage" "auth" {
  api_id      = aws_apigatewayv2_api.auth.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "auth" {
  api_id                 = aws_apigatewayv2_api.auth.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.auth.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "auth_email" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "POST /auth/email"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "auth_verify" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "POST /auth/verification-code"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "auth_email_options" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "OPTIONS /auth/email"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "auth_verify_options" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "OPTIONS /auth/verification-code"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.auth.execution_arn}/*/*"
}

# --- Outputs ---
output "nameservers" {
  value       = aws_route53_zone.main.name_servers
  description = "Update these in Namecheap!"
}

output "website_url" {
  value = "https://${var.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.s3_distribution.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.s3_distribution.domain_name
}

# --- Backend Outputs ---
output "api_gateway_url" {
  value       = aws_apigatewayv2_stage.auth.invoke_url
  description = "Backend API URL – use as backendBaseUrl"
}

# --- Write backend URL to frontend .env ---
resource "local_file" "frontend_env" {
  filename = "${path.module}/beijaflorsolutions/.env"
  content  = "VITE_BACKEND_URL=${aws_apigatewayv2_stage.auth.invoke_url}\n"
}
