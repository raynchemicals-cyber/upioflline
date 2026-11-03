/**
 * In-repository pure JavaScript implementation of an Isolation Forest
 * for unsupervised anomaly detection on tabular mesh payment signals.
 *
 * Features:
 *   [hopCount, latencySeconds, senderVelocity, amount, relayReputation]
 */

class IsolationTreeNode {
  constructor({ splitFeature = null, splitValue = null, left = null, right = null, size = 0, isLeaf = false }) {
    this.splitFeature = splitFeature;
    this.splitValue = splitValue;
    this.left = left;
    this.right = right;
    this.size = size;
    this.isLeaf = isLeaf;
  }
}

export class IsolationForest {
  constructor({ numTrees = 50, subSampleSize = 128, maxDepth = null } = {}) {
    this.numTrees = numTrees;
    this.subSampleSize = subSampleSize;
    this.maxDepth = maxDepth || Math.ceil(Math.log2(Math.max(subSampleSize, 2)));
    this.trees = [];
  }

  /**
   * Train the forest on synthetic or historical feature vectors.
   * @param {number[][]} data Array of numerical feature arrays
   */
  fit(data) {
    if (!data || data.length === 0) return;
    this.trees = [];
    const n = data.length;
    const sampleSize = Math.min(this.subSampleSize, n);

    for (let i = 0; i < this.numTrees; i++) {
      const sample = this.subSample(data, sampleSize);
      const tree = this.buildTree(sample, 0, this.maxDepth);
      this.trees.push(tree);
    }
  }

  subSample(data, size) {
    const indices = new Set();
    while (indices.size < size && indices.size < data.length) {
      indices.add(Math.floor(Math.random() * data.length));
    }
    return Array.from(indices).map((idx) => data[idx]);
  }

  buildTree(data, currentDepth, maxDepth) {
    if (data.length <= 1 || currentDepth >= maxDepth) {
      return new IsolationTreeNode({ size: data.length, isLeaf: true });
    }

    const numFeatures = data[0].length;
    const featureIdx = Math.floor(Math.random() * numFeatures);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const val = data[i][featureIdx];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    if (min === max) {
      return new IsolationTreeNode({ size: data.length, isLeaf: true });
    }

    const splitValue = min + Math.random() * (max - min);
    const leftData = [];
    const rightData = [];

    for (let i = 0; i < data.length; i++) {
      if (data[i][featureIdx] < splitValue) {
        leftData.push(data[i]);
      } else {
        rightData.push(data[i]);
      }
    }

    return new IsolationTreeNode({
      splitFeature: featureIdx,
      splitValue,
      left: this.buildTree(leftData, currentDepth + 1, maxDepth),
      right: this.buildTree(rightData, currentDepth + 1, maxDepth),
      size: data.length,
      isLeaf: false,
    });
  }

  pathLength(x, node, currentDepth) {
    if (node.isLeaf) {
      return currentDepth + this.c(node.size);
    }
    const val = x[node.splitFeature];
    if (val < node.splitValue) {
      return this.pathLength(x, node.left, currentDepth + 1);
    }
    return this.pathLength(x, node.right, currentDepth + 1);
  }

  /**
   * Average path length adjustment factor c(n)
   */
  c(n) {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    // Euler-Mascheroni constant ≈ 0.5772156649
    return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
  }

  /**
   * Predicts anomaly score between 0.0 and 1.0.
   * Score > 0.6 indicates high anomaly probability.
   * @param {number[]} x Single feature vector
   * @returns {number} Score from 0 to 1
   */
  score(x) {
    if (this.trees.length === 0) return 0.5;

    let totalPath = 0;
    for (const tree of this.trees) {
      totalPath += this.pathLength(x, tree, 0);
    }
    const avgPath = totalPath / this.trees.length;
    const cN = this.c(this.subSampleSize);
    if (cN === 0) return 0.5;

    // s(x, n) = 2 ^ (-E(h(x)) / c(n))
    return Math.pow(2, -avgPath / cN);
  }
}
