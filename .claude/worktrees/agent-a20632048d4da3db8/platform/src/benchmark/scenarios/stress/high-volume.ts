/**
 * High Volume Stress Test Scenario
 *
 * Tests system performance with a large number of messages.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';

/**
 * Generate high volume stress test messages
 *
 * Creates a large number of realistic messages to test
 * system throughput, scalability, and performance.
 */
export function generateHighVolumeScenario(count: number = 5000): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999990;
  const senderId = 999990;
  const senderName = 'Stress Test User';
  const senderUsername = 'stress';

  // Message templates for variety
  const templates = [
    "Thinking about implementing {concept} for the new project.",
    "Had a discussion with {person} about {concept}. Interesting insights!",
    "The {organization} team is making progress on {concept}.",
    "Need to investigate {concept} further before the meeting.",
    "{person} mentioned that {concept} could improve our workflow.",
    "Reading documentation on {concept}. Pretty complex but useful.",
    "Deployed {concept} to staging. Looking good so far.",
    "Bug report: {concept} is causing issues in production.",
    "Great article about {concept} on {organization}'s blog.",
    "Refactoring the {concept} module for better performance.",
  ];

  const concepts = [
    'Kubernetes', 'Docker', 'microservices', 'React', 'Vue.js', 'Node.js',
    'PostgreSQL', 'MongoDB', 'Redis', 'GraphQL', 'REST APIs', 'gRPC',
    'TypeScript', 'Python', 'Go', 'Rust', 'CI/CD', 'Jenkins', 'GitHub Actions',
    'AWS', 'Azure', 'GCP', 'Terraform', 'Ansible', 'monitoring', 'logging',
    'security', 'authentication', 'OAuth', 'JWT', 'encryption', 'firewall',
  ];

  const people = [
    'John', 'Sarah', 'Mike', 'Emily', 'David', 'Lisa', 'Tom', 'Anna',
    'Chris', 'Emma', 'James', 'Mary', 'Robert', 'Jennifer', 'Michael',
  ];

  const organizations = [
    'Engineering', 'Product', 'DevOps', 'Security', 'Data Science',
    'Design', 'Marketing', 'Sales', 'Support', 'HR', 'Finance',
  ];

  // Generate messages distributed over time
  const now = Date.now();
  const timespan = 90 * 24 * 60 * 60 * 1000; // 90 days

  for (let i = 0; i < count; i++) {
    // Random timestamp within the timespan
    const timestamp = new Date(now - Math.random() * timespan);
    const messageId = baseId + i;

    // Select random template and fill in placeholders
    const templateIdx = Math.floor(Math.random() * templates.length);
    const template = templates[templateIdx] ?? templates[0] ?? 'Default message about {concept}.';
    const conceptIdx = Math.floor(Math.random() * concepts.length);
    const concept = concepts[conceptIdx] ?? concepts[0] ?? 'system';
    const personIdx = Math.floor(Math.random() * people.length);
    const person = people[personIdx] ?? people[0] ?? 'someone';
    const orgIdx = Math.floor(Math.random() * organizations.length);
    const org = organizations[orgIdx] ?? organizations[0] ?? 'Team';

    let text = template
      .replace(/{concept}/g, concept)
      .replace(/{person}/g, person)
      .replace(/{organization}/g, org);

    // Occasional link message
    if (Math.random() < 0.1) {
      const safeConcept = concept ?? 'system';
      text += ` Check: https://example.com/${safeConcept.toLowerCase().replace(' ', '-')}`;
    }

    // Occasional task message
    if (Math.random() < 0.05) {
      text = `Remind me to review ${concept} documentation.`;
    }

    // Occasional question
    if (Math.random() < 0.08) {
      text = `? What's the best way to implement ${concept}?`;
    }

    messages.push({
      chatId,
      messageId,
      senderId,
      senderName,
      senderUsername,
      text,
      timestamp: timestamp.toISOString(),
      benchmarkMetadata: {
        scenario: 'high-volume',
      },
    });
  }

  // Sort by timestamp for realistic processing order
  messages.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return messages;
}

/**
 * Expected ground truth for high volume scenario
 *
 * Note: For stress tests, we don't validate exact ground truth.
 * Instead, we measure performance metrics and processing success rate.
 */
export const HIGH_VOLUME_GROUND_TRUTH = {
  scenario: 'high-volume',
  description: 'Stress test with high message volume',

  expectedEntities: [], // Not validated for stress tests
  expectedFacts: [],
  expectedTasks: [],
  expectedMemories: [],

  // For stress tests, we focus on:
  // - Processing throughput (messages/second)
  // - Error rate (failed injections / processed)
  // - Memory usage
  // - Database performance
};
