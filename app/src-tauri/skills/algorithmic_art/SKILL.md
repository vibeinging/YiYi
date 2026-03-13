---
name: algorithmic_art
description: "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems."
metadata:
  {
    "yiyiclaw":
      {
        "emoji": "🎨",
        "requires": {}
      }
  }
---

Algorithmic philosophies are computational aesthetic movements that are then expressed through code. Output .md files (philosophy), .html files (interactive viewer), and .js files (generative algorithms).

This happens in two steps:
1. Algorithmic Philosophy Creation (.md file)
2. Express by creating p5.js generative art (.html + .js files)

First, undertake this task:

## ALGORITHMIC PHILOSOPHY CREATION

To begin, create an ALGORITHMIC PHILOSOPHY (not static images or templates) that will be interpreted through:
- Computational processes, emergent behavior, mathematical beauty
- Seeded randomness, noise fields, organic systems
- Particles, flows, fields, forces
- Parametric variation and controlled chaos

### THE CRITICAL UNDERSTANDING
- What is received: Some subtle input or instructions by the user to take into account, but use as a foundation; it should not constrain creative freedom.
- What is created: An algorithmic philosophy/generative aesthetic movement.
- What happens next: The same version receives the philosophy and EXPRESSES IT IN CODE - creating p5.js sketches that are 90% algorithmic generation, 10% essential parameters.

The philosophy must emphasize: Algorithmic expression. Emergent behavior. Computational beauty. Seeded variation.

### TECHNICAL REQUIREMENTS

**Seeded Randomness (Art Blocks Pattern)**:
```javascript
let seed = 12345;
randomSeed(seed);
noiseSeed(seed);
```

**Canvas Setup**: Standard p5.js structure with createCanvas(1200, 1200).

### OUTPUT FORMAT

Output:
1. **Algorithmic Philosophy** - As markdown explaining the generative aesthetic
2. **Single HTML Artifact** - Self-contained interactive generative art with p5.js (from CDN), the algorithm, parameter controls, and UI - all in one file
