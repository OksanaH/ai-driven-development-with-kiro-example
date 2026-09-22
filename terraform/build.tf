# --- Lambda bundling ---
#
# Nodejs Function runs esbuild to compile the TypeScript handler (and the
# src/ pipeline it imports) into a single CommonJS file, marking @aws-sdk/* as
# external because it is already present in the Lambda runtime. Terraform has no
# built-in equivalent, so we reproduce that build with a local esbuild call and
# then zip the result with the archive provider.
#
# esbuild is already a devDependency of lambda/package.json, so we invoke it from
# there via `npx`. The build runs whenever any handler or src/ source file
# changes (tracked through the source_hash trigger below).

locals {
  # terraform/  ->  repo root
  repo_root     = abspath("${path.module}/..")
  handler_entry = "lambda/handler.ts"
  build_dir     = "${path.module}/.build"
  bundle_file   = "${local.build_dir}/index.js"

  # The static frontend served by the handler on GET /. It must be packaged
  # into the Lambda bundle next to index.js so the handler can read it.
  index_html = "${local.repo_root}/public/index.html"

  # Rebuild when the handler, any pipeline source under src/, or the frontend
  # asset changes. Each entry is hashed so edits invalidate the build trigger.
  src_hashes      = [for f in fileset("${local.repo_root}/src", "**/*.ts") : filesha1("${local.repo_root}/src/${f}")]
  handler_hash    = filesha1(local.handler_entry)
  index_html_hash = filesha1(local.index_html)
  source_hash     = sha1(join("", concat([local.handler_hash, local.index_html_hash], local.src_hashes)))
}

resource "null_resource" "bundle" {
  triggers = {
    source_hash = local.source_hash
  }

  provisioner "local-exec" {
    working_dir = "lambda"
    
    # Using relative paths for both entry point and outfile avoids space-quoting issues on Windows.
    # working_dir is terraform/lambda, so the entry is handler.ts and the output
    # goes one level up into terraform/.build/index.js.
    command = "npx esbuild handler.ts --bundle --platform=node --target=node20 --format=cjs --sourcemap --external:@aws-sdk/* --outfile=../.build/index.js"
  }
}

# Copy the static frontend into the bundle directory so it is packaged next to
# index.js. The handler resolves index.html relative to __dirname (the unzipped
# bundle root), so it must live alongside the compiled handler in the zip.
resource "local_file" "index_html" {
  content  = file(local.index_html)
  filename = "${local.build_dir}/index.html"

  depends_on = [null_resource.bundle]
}

# Zip the bundle for Lambda deployment.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.build_dir
  output_path = "${path.module}/lambda.zip"

  depends_on = [
    null_resource.bundle,
    local_file.index_html,
  ]
}
