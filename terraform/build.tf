# --- Lambda bundling ---
#
# CDK's NodejsFunction runs esbuild to compile the TypeScript handler (and the
# src/ pipeline it imports) into a single CommonJS file, marking @aws-sdk/* as
# external because it is already present in the Lambda runtime. Terraform has no
# built-in equivalent, so we reproduce that build with a local esbuild call and
# then zip the result with the archive provider.
#
# esbuild is already a devDependency of infra/package.json, so we invoke it from
# there via `npx`. The build runs whenever any handler or src/ source file
# changes (tracked through the source_hash trigger below).

locals {
  # terraform/  ->  repo root
  repo_root     = abspath("${path.module}/..")
  handler_entry = "${local.repo_root}/infra/lambda/handler.ts"
  build_dir     = "${path.module}/.build"
  bundle_file   = "${local.build_dir}/index.js"

  # Rebuild when the handler or any pipeline source under src/ changes. Each
  # entry is hashed by its absolute path so edits invalidate the build trigger.
  src_hashes   = [for f in fileset("${local.repo_root}/src", "**/*.ts") : filesha1("${local.repo_root}/src/${f}")]
  handler_hash = filesha1(local.handler_entry)
  source_hash  = sha1(join("", concat([local.handler_hash], local.src_hashes)))
}

# Run esbuild to produce a single CJS bundle at .build/index.js.
resource "null_resource" "bundle" {
  triggers = {
    source_hash = local.source_hash
  }

  provisioner "local-exec" {
    working_dir = "${local.repo_root}/infra"
    # Mirror the CDK bundling options: CJS, node20 target, sourcemap, and the
    # AWS SDK v3 left external (provided by the Lambda runtime).
    command = join(" ", [
      "npx esbuild",
      "\"${local.handler_entry}\"",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--sourcemap",
      "--external:@aws-sdk/*",
      "--outfile=\"${abspath(local.bundle_file)}\"",
    ])
  }
}

# Zip the bundle for Lambda deployment.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.build_dir
  output_path = "${path.module}/.build/lambda.zip"

  depends_on = [null_resource.bundle]
}
