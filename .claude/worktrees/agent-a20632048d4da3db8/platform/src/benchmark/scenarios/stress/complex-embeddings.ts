/**
 * Complex Embeddings Stress Test Scenario
 *
 * Tests system performance with large content that requires
 * complex embedding generation (articles, long texts).
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';

/**
 * Generate complex embeddings stress test messages
 *
 * Creates messages with substantial content that requires
 * processing and embedding generation.
 */
export function generateComplexEmbeddingsScenario(count: number = 200): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999890;
  const senderId = 999890;
  const senderName = 'Content User';
  const senderUsername = 'content';

  // Simulated article/content templates
  const longContents = [
    `# Microservices Architecture Patterns

Microservices architecture has become increasingly popular for building scalable, maintainable applications. This approach structures an application as a collection of loosely coupled services, each running in its own process and communicating with lightweight mechanisms.

## Key Benefits

1. **Scalability**: Individual services can be scaled independently based on demand.
2. **Flexibility**: Different services can use different technologies optimized for specific tasks.
3. **Resilience**: Failure in one service doesn't necessarily bring down the entire system.
4. **Deployability**: Services can be deployed independently, enabling faster iteration.

## Common Patterns

- API Gateway: Single entry point for all clients
- Service Discovery: Dynamic service registration and lookup
- Circuit Breaker: Preventing cascading failures
- Event Sourcing: Storing state as a sequence of events
- CQRS: Separating read and write operations`,

    `# Kubernetes: Container Orchestration

Kubernetes has emerged as the de facto standard for container orchestration, providing powerful tools for deploying, scaling, and managing containerized applications.

## Core Concepts

**Pods**: The smallest deployable units in Kubernetes, representing a single instance of a running process.

**Services**: Stable network endpoints for pods, enabling load balancing and service discovery.

**Deployments**: Declarative way to manage pod replicas and updates.

**Namespaces**: Virtual clusters within a physical cluster for resource isolation.

## Architecture Components

- Control Plane: Manages the cluster state
- Worker Nodes: Run containerized applications
- etcd: Distributed key-value store for configuration
- kube-apiserver: Central management API
- kube-scheduler: Assigns pods to nodes
- kube-controller-manager: Runs controller processes`,

    `# Machine Learning Operations (MLOps)

MLOps bridges the gap between machine learning development and operations, focusing on the reliable and efficient deployment of ML models in production.

## Key Challenges

1. **Model Versioning**: Tracking which model version is in production
2. **Data Drift**: Monitoring changes in input data distribution
3. **Performance Monitoring**: Tracking model accuracy over time
4. **Retraining Pipelines**: Automating model updates with new data

## Best Practices

- Establish clear metrics for model performance
- Implement automated testing for model quality
- Create reproducible training pipelines
- Monitor for data and concept drift
- Maintain detailed model documentation
- Plan for model rollback capabilities`,

    `# GraphQL vs REST APIs

When choosing between GraphQL and REST for API design, consider the specific needs of your application and use cases.

## GraphQL Advantages

- **Flexible Queries**: Clients request exactly what they need
- **Single Request**: Fetch multiple resources in one call
- **Strong Typing**: Schema provides clear contract
- **Real-time Updates**: Built-in subscription support

## REST Advantages

- **Simplicity**: Easier to understand and implement
- **Caching**: Leverages HTTP caching mechanisms
- **Statelessness**: Each request contains all necessary information
- **Maturity**: Well-established ecosystem and tooling

## When to Choose

Use GraphQL for complex data requirements and mobile apps. Use REST for simple CRUD operations and when leveraging standard HTTP caching is important.`,
  ];

  // Generate messages with long content
  const now = Date.now();
  const timespan = 30 * 24 * 60 * 60 * 1000; // 30 days

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(now - Math.random() * timespan);
    const messageId = baseId + i;

    // Alternate between long articles and shorter discussions
    let text: string;
    if (i % 3 === 0) {
      // Long content (article)
      const content = longContents[i % longContents.length];
      text = `📄 Just read this great article:\n\n${content}\n\nThoughts?`;
    } else if (i % 3 === 1) {
      // Medium-length summary/discussion
      text = `Great discussion about ${['microservices', 'Kubernetes', 'MLOps', 'GraphQL'][i % 4]}! ` +
        `The key points were about scalability, performance, and developer experience. ` +
        `I think the trade-offs mentioned are really important for our architecture decisions. ` +
        `We should consider these patterns for our upcoming ${['migration', 'refactor', 'deployment', 'redesign'][i % 4]}.`;
    } else {
      // Link with context
      text = `Check out this resource on ${['container orchestration', 'ML deployment', 'API design'][i % 3]}: ` +
        `https://example.com/article-${i}\n\n` +
        `It covers best practices and common pitfalls. Really relevant to what we're working on.`;
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
        scenario: 'complex-embeddings',
      },
    });
  }

  // Sort by timestamp
  messages.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return messages;
}

/**
 * Expected ground truth for complex embeddings scenario
 */
export const COMPLEX_EMBEDDINGS_GROUND_TRUTH = {
  scenario: 'complex-embeddings',
  description: 'Stress test with large content requiring complex embeddings',

  expectedEntities: [], // Not validated - focus on embedding performance
  expectedFacts: [],
  expectedTasks: [],
  expectedMemories: [],

  // For complex embeddings, we measure:
  // - Embedding generation time
  // - Memory usage during processing
  // - Embedding quality (semantic search effectiveness)
};
