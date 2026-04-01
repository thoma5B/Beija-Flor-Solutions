# --- DynamoDB Table (unified) ---
resource "aws_dynamodb_table" "data" {
  name         = "beijaflor-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"
  range_key    = "recordType"

  attribute {
    name = "email"
    type = "S"
  }

  attribute {
    name = "recordType"
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

# --- SES Domain Identity ---
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

# SES Mail From
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

# --- IAM Role for Lambda ---
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
          "dynamodb:DeleteItem",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.data.arn
      }
    ]
  })
}

# --- Lambda Function ---
data "archive_file" "auth_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/backend/auth/dist"
  output_path = "${path.module}/backend/auth.zip"
}

resource "aws_lambda_function" "auth" {
  filename         = data.archive_file.auth_lambda.output_path
  function_name    = "beijaflor-auth"
  role             = aws_iam_role.lambda_auth.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.auth_lambda.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.data.name
      SENDER_EMAIL     = var.sender_email
      DEEPSEEK_API_KEY = var.deepseek_api_key
    }
  }

  depends_on = [aws_iam_role_policy.lambda_auth]
}

# --- API Gateway HTTP API ---
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

resource "aws_apigatewayv2_route" "chat_message" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "POST /chat/message"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "chat_message_options" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "OPTIONS /chat/message"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "chat_send" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "POST /chat/send"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_apigatewayv2_route" "chat_send_options" {
  api_id    = aws_apigatewayv2_api.auth.id
  route_key = "OPTIONS /chat/send"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.auth.execution_arn}/*/*"
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
