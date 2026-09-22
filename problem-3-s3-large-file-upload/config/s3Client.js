const { S3Client } = require('@aws-sdk/client-s3');

/**
 * If AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are set, use them (handy for
 * local development). Otherwise fall back to the SDK's default credential
 * provider chain - which is what you want in any real deployment (an IAM
 * role attached to the EC2 instance / ECS task / Lambda, etc.), so
 * credentials are never hardcoded or checked into the repo.
 */
const explicitCreds =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {};

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  ...explicitCreds,
});

module.exports = s3;
