#!/usr/bin/env node
/**
 * Benchmark Verification Script
 *
 * Tests the benchmark system components without requiring a full database.
 */

import { generateDeduplicationScenario } from './scenarios/quality/deduplication.js';
import { generateEntityExtractionScenario } from './scenarios/quality/entity-extraction.js';
import { generateTemporalTrackingScenario } from './scenarios/quality/temporal-tracking.js';
import { generateConflictsScenario } from './scenarios/edge-cases/conflicts.js';
import { buildConfig } from './config.js';
import { getGroundTruth } from './collector/ground-truth.js';

interface VerificationResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  details?: any;
}

const results: VerificationResult[] = [];

function test(name: string, fn: () => VerificationResult): void {
  try {
    const result = fn();
    results.push(result);
    const icon = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⚠️';
    console.log(`${icon} ${name}: ${result.message}`);
    if (result.details) {
      console.log(`   ${JSON.stringify(result.details, null, 2)}`);
    }
  } catch (error) {
    results.push({
      name,
      status: 'fail',
      message: `Exception: ${error}`,
    });
    console.log(`❌ ${name}: Exception - ${error}`);
  }
}

// Test 1: Configuration System
test('Configuration: buildConfig defaults', () => {
  const config = buildConfig({});
  if (config.messageCount === 500) {
    return {
      name: 'Configuration: buildConfig defaults',
      status: 'pass',
      message: 'Default medium scale has 500 messages',
      details: { messageCount: config.messageCount },
    };
  }
  return {
    name: 'Configuration: buildConfig defaults',
    status: 'fail',
    message: `Expected 500 messages, got ${config.messageCount}`,
  };
});

test('Configuration: scale presets', () => {
  const light = buildConfig({ scale: 'light' });
  const medium = buildConfig({ scale: 'medium' });
  const heavy = buildConfig({ scale: 'heavy' });

  if (light.messageCount === 100 && medium.messageCount === 500 && heavy.messageCount === 2000) {
    return {
      name: 'Configuration: scale presets',
      status: 'pass',
      message: 'Scale presets configured correctly',
      details: { light: light.messageCount, medium: medium.messageCount, heavy: heavy.messageCount },
    };
  }
  return {
    name: 'Configuration: scale presets',
    status: 'fail',
    message: 'Scale presets incorrect',
    details: { light: light.messageCount, medium: medium.messageCount, heavy: heavy.messageCount },
  };
});

// Test 2: Message Generation
test('Scenario: deduplication generates messages', () => {
  const messages = generateDeduplicationScenario();
  if (messages.length > 0 && messages.length < 100) {
    return {
      name: 'Scenario: deduplication generates messages',
      status: 'pass',
      message: `Generated ${messages.length} messages`,
      details: {
        firstMessageText: messages[0]?.text?.substring(0, 50),
        lastMessageText: messages[messages.length - 1]?.text?.substring(0, 50),
      },
    };
  }
  return {
    name: 'Scenario: deduplication generates messages',
    status: 'fail',
    message: `Expected 1-99 messages, got ${messages.length}`,
  };
});

test('Scenario: entity-extraction generates messages', () => {
  const messages = generateEntityExtractionScenario();
  if (messages.length > 0) {
    return {
      name: 'Scenario: entity-extraction generates messages',
      status: 'pass',
      message: `Generated ${messages.length} messages`,
      details: { sample: messages[0]?.text?.substring(0, 50) },
    };
  }
  return {
    name: 'Scenario: entity-extraction generates messages',
    status: 'fail',
    message: `No messages generated`,
  };
});

test('Scenario: temporal-tracking generates messages', () => {
  const messages = generateTemporalTrackingScenario();
  if (messages.length > 0) {
    return {
      name: 'Scenario: temporal-tracking generates messages',
      status: 'pass',
      message: `Generated ${messages.length} messages`,
      details: { sample: messages[0]?.text?.substring(0, 50) },
    };
  }
  return {
    name: 'Scenario: temporal-tracking generates messages',
    status: 'fail',
    message: `No messages generated`,
  };
});

test('Scenario: conflicts generates messages', () => {
  const messages = generateConflictsScenario();
  if (messages.length > 0) {
    return {
      name: 'Scenario: conflicts generates messages',
      status: 'pass',
      message: `Generated ${messages.length} messages`,
      details: { sample: messages[0]?.text?.substring(0, 50) },
    };
  }
  return {
    name: 'Scenario: conflicts generates messages',
    status: 'fail',
    message: `No messages generated`,
  };
});

// Test 3: Message Structure Validation
test('Message: structure is valid', () => {
  const messages = generateDeduplicationScenario();
  const msg = messages[0];

  const hasRequiredFields =
    msg &&
    typeof msg.chatId === 'number' &&
    typeof msg.messageId === 'number' &&
    typeof msg.senderId === 'number' &&
    typeof msg.senderName === 'string' &&
    typeof msg.text === 'string' &&
    typeof msg.timestamp === 'string';

  if (hasRequiredFields) {
    return {
      name: 'Message: structure is valid',
      status: 'pass',
      message: 'Message has all required fields',
      details: {
        chatId: msg.chatId,
        messageId: msg.messageId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        hasText: !!msg.text,
        hasTimestamp: !!msg.timestamp,
      },
    };
  }
  return {
    name: 'Message: structure is valid',
    status: 'fail',
    message: 'Message missing required fields',
    details: { msg },
  };
});

test('Message: timestamps are valid ISO strings', () => {
  const messages = generateDeduplicationScenario();
  const allValid = messages.every(msg => {
    const date = new Date(msg.timestamp);
    return !isNaN(date.getTime());
  });

  if (allValid) {
    return {
      name: 'Message: timestamps are valid ISO strings',
      status: 'pass',
      message: `All ${messages.length} messages have valid timestamps`,
    };
  }
  return {
    name: 'Message: timestamps are valid ISO strings',
    status: 'fail',
    message: 'Some messages have invalid timestamps',
  };
});

test('Message: metadata is present', () => {
  const messages = generateDeduplicationScenario();
  const withMetadata = messages.filter(msg => msg.benchmarkMetadata);

  if (withMetadata.length === messages.length) {
    return {
      name: 'Message: metadata is present',
      status: 'pass',
      message: 'All messages have benchmark metadata',
      details: { sampleMetadata: messages[0]?.benchmarkMetadata },
    };
  }
  return {
    name: 'Message: metadata is present',
    status: 'warn',
    message: `${withMetadata.length}/${messages.length} messages have metadata`,
  };
});

// Test 4: Ground Truth
test('Ground Truth: deduplication scenario has expected entities', () => {
  const truth = getGroundTruth('deduplication');

  if (truth && truth.expectedEntities && truth.expectedEntities.length > 0) {
    return {
      name: 'Ground Truth: deduplication scenario has expected entities',
      status: 'pass',
      message: `Found ${truth.expectedEntities.length} expected entities`,
      details: { entities: truth.expectedEntities.map((e: any) => e.name) },
    };
  }
  return {
    name: 'Ground Truth: deduplication scenario has expected entities',
    status: 'fail',
    message: 'No ground truth or expected entities found',
  };
});

// Summary
console.log('\n' + '='.repeat(60));
const passed = results.filter(r => r.status === 'pass').length;
const failed = results.filter(r => r.status === 'fail').length;
const warned = results.filter(r => r.status === 'warn').length;

console.log(`\n📊 Verification Summary:`);
console.log(`   ✅ Passed: ${passed}`);
console.log(`   ❌ Failed: ${failed}`);
console.log(`   ⚠️  Warnings: ${warned}`);
console.log(`   📈 Total: ${results.length}`);

if (failed === 0) {
  console.log('\n✅ All verification tests passed!');
  console.log('\nNext steps:');
  console.log('1. Ensure PostgreSQL and Qdrant are running');
  console.log('2. Ensure message-processor worker is running');
  console.log('3. Run: pnpm run benchmark --scenario deduplication');
} else {
  console.log('\n❌ Some verification tests failed. Please fix before running benchmarks.');
  process.exit(1);
}
