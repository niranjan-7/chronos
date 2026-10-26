import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookCryptoService } from './webhook-crypto.service';

describe('WebhookCryptoService (Enterprise Cryptographic Signing & AES-256-GCM)', () => {
  let service: WebhookCryptoService;
  const mockEncryptionKey = 'my-super-secret-jwt-key-32-chars-long!';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookCryptoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WEBHOOK_ENCRYPTION_KEY') return mockEncryptionKey;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WebhookCryptoService>(WebhookCryptoService);
  });

  describe('AES-256-GCM Secret Encryption at Rest', () => {
    it('should encrypt secret with authenticated AES-256-GCM format', () => {
      const rawSecret = 'whsec_9b8c7d6e5f4a3b2c1d0e';
      const encrypted = service.encryptSecret(rawSecret);

      expect(encrypted).toBeDefined();
      expect(encrypted.startsWith('enc:v1:')).toBe(true);
      const parts = encrypted.split(':');
      expect(parts.length).toBe(5); // enc, v1, iv, tag, ciphertext
      expect(parts[2].length).toBe(24); // 12-byte IV in hex = 24 chars
      expect(parts[3].length).toBe(32); // 16-byte auth tag in hex = 32 chars
    });

    it('should decrypt encrypted secret back to original raw value', () => {
      const rawSecret = 'whsec_enterprise_corporate_slack_secret';
      const encrypted = service.encryptSecret(rawSecret);
      const decrypted = service.decryptSecret(encrypted);

      expect(decrypted).toBe(rawSecret);
    });

    it('should pass through unencrypted secrets for backwards-compatibility', () => {
      const plainSecret = 'plain_test_secret_123';
      const decrypted = service.decryptSecret(plainSecret);
      expect(decrypted).toBe(plainSecret);
    });

    it('should throw on tampered ciphertext or auth tag (integrity violation)', () => {
      const rawSecret = 'whsec_confidential';
      const encrypted = service.encryptSecret(rawSecret);
      const parts = encrypted.split(':');
      // Tamper ciphertext
      parts[4] = 'ff' + parts[4].slice(2);
      const tampered = parts.join(':');

      expect(() => service.decryptSecret(tampered)).toThrow('Decryption failure for webhook secret');
    });
  });

  describe('HMAC-SHA256 Payload Signing & Header Generation', () => {
    const secret = 'whsec_test_secret_for_hmac';
    const payload = JSON.stringify({ event: 'sla.breach', ticketId: 't-123', priority: 'URGENT' });
    const currentTimestamp = Math.floor(Date.now() / 1000);

    it('should generate standard X-Chronos-Signature header format: t={timestamp},v1={hmac}', () => {
      const { headerValue, signature } = service.createSignatureHeader(payload, secret, currentTimestamp);

      expect(headerValue).toBe(`t=${currentTimestamp},v1=${signature}`);
      expect(signature).toHaveLength(64); // 32-byte SHA256 in hex = 64 chars
    });

    it('should verify signature successfully when body, secret, and timestamp match', () => {
      const { headerValue } = service.createSignatureHeader(payload, secret, currentTimestamp);
      const isValid = service.verifySignature(headerValue, payload, secret, 300);

      expect(isValid).toBe(true);
    });

    it('should reject signature when payload body is modified (anti-tamper)', () => {
      const { headerValue } = service.createSignatureHeader(payload, secret, currentTimestamp);
      const tamperedPayload = JSON.stringify({ event: 'sla.breach', ticketId: 't-999', priority: 'URGENT' });
      const isValid = service.verifySignature(headerValue, tamperedPayload, secret, 300);

      expect(isValid).toBe(false);
    });

    it('should reject signature when secret is incorrect', () => {
      const { headerValue } = service.createSignatureHeader(payload, secret, currentTimestamp);
      const isValid = service.verifySignature(headerValue, payload, 'wrong_secret', 300);

      expect(isValid).toBe(false);
    });

    it('should reject signature if timestamp exceeds tolerance (replay attack prevention)', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const { headerValue } = service.createSignatureHeader(payload, secret, oldTimestamp);

      // Default tolerance is 300 seconds (5 mins)
      const isValid = service.verifySignature(headerValue, payload, secret, 300);
      expect(isValid).toBe(false);
    });
  });
});
