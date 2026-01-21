TF_DIR ?= .
AWS_PROFILE ?= thomasbunke
TF = terraform -chdir=$(TF_DIR)
PLAN_FILE = tfplan

.PHONY: init plan apply deploy invalidate outputs fmt clean cloudfront-id

init:
	$(TF) init -input=false

plan: init
	$(TF) plan -out=$(PLAN_FILE)

apply: plan
	$(TF) apply -auto-approve $(PLAN_FILE)

outputs:
	$(TF) output -json

cloudfront-id:
	@$(TF) output -raw cloudfront_distribution_id

invalidate: cloudfront-id
	DIST_ID=`$(TF) output -raw cloudfront_distribution_id`; \
	if [ -z "$$DIST_ID" ]; then \
	  echo "cloudfront_distribution_id not found in terraform outputs"; exit 1; \
	fi; \
	echo "\nInvalidating CloudFront..."; \
	INVALIDATION_ID=`aws --profile $(AWS_PROFILE) cloudfront create-invalidation --distribution-id $$DIST_ID --paths "/*" --query 'Invalidation.Id' --output text`; \
	echo "Created invalidation $$INVALIDATION_ID; checking status ..."; \
	while [ "$$STATUS" != "Completed" ]; do \
	  sleep 3; \
	  STATUS=`aws --profile $(AWS_PROFILE) cloudfront get-invalidation --distribution-id $$DIST_ID --id $$INVALIDATION_ID --query 'Invalidation.Status' --output text`; \
	  echo "$$STATUS"; \
	  [ "$$STATUS" = "Completed" ] && break; \
	done; \


deploy: plan apply invalidate
	@echo "Deployment complete."

fmt:
	$(TF) fmt

clean:
	-rm -f $(PLAN_FILE)