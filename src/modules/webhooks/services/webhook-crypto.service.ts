import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class WebhookCryptoService {
  private readonly logger = new Logger(WebhookCryptoService.name);
  private readonly encryptionKey: Buffer;

  constructor(private readonly config: ConfigService) {
    const rawKey =
      this.config.get<string>('WEBHOOK_ENCRYPTION_KEY') ||
      this.config.get<string>('JWT_SECRET') ||
      'chronos-enterprise-webhook-encryption-key-32-chars!!';
    // Derives fixed 32-byte key for AES-256
    this.encryptionKey = crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * Encrypts a signing secret at rest using AES-256-GCM.
   * Format: enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
   */
  encryptSecret(plainText: string): string {
    if (!plainText) return '';
    const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts an encrypted signing secret.
   * If secret is not encrypted (e.g. legacy/test data), gracefully returns the raw string.
   */
  decryptSecret(encryptedOrPlain: string): string {
    if (!encryptedOrPlain) return '';
    if (!encryptedOrPlain.startsWith('enc:v1:')) {
      return encryptedOrPlain;
    }

    try {
      const parts = encryptedOrPlain.split(':');
      if (parts.length !== 5) {
        throw new Error('Malformed encrypted secret format');
      }

      const iv = Buffer.from(parts[2], 'hex');
      const authTag = Buffer.from(parts[3], 'hex');
      const cipherText = parts[4];

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(cipherText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      this.logger.error(`Failed to decrypt webhook signing secret: ${err.message}`);
      throw new Error('Decryption failure for webhook secret');
    }
  }

  /**
   * Computes HMAC-SHA256 signature over timestamp and body.
   */
  generateSignature(rawBody: string, secret: string, timestamp: number): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
  }

  /**
   * Generates the standard X-Chronos-Signature header:
   * t={unix_timestamp},v1={HMAC_SHA256(timestamp + "." + raw_json_body, signing_secret)}
   */
  createSignatureHeader(
    rawBody: string,
    secret: string,
    timestamp: number = Math.floor(Date.now() / 1000),
  ): { headerValue: string; timestamp: number; signature: string } {
    const signature = this.generateSignature(rawBody, secret, timestamp);
    const headerValue = `t=${timestamp},v1=${signature}`;
    return { headerValue, timestamp, signature };
  }

  /**
   * Verifies an incoming X-Chronos-Signature header against the raw body and secret.
   * Rejects if the timestamp is older than toleranceSeconds (replay attack prevention).
   */
  verifySignature(
    signatureHeader: string,
    rawBody: string,
    secret: string,
    toleranceSeconds: number = 300,
  ): boolean {
    if (!signatureHeader) return false;

    const parts = signatureHeader.split(',');
    let timestampStr = '';
    let signature = '';

    for (const part of parts) {
      const [key, val] = part.split('=');
      if (key === 't') timestampStr = val;
      if (key === 'v1') signature = val;
    }

    if (!timestampStr || !signature) return false;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    // Check tolerance (prevent replay attacks)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    const expectedSignature = this.generateSignature(rawBody, secret, timestamp);

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex'),
      );
    } catch {
      return false;
    }
  }
}
