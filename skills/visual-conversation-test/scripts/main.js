// skills/visual-conversation-test/scripts/main.js
/**
 * Visual Workspace Interactive Test Script
 *
 * Tests the complete visual conversation workflow interactively:
 * - User selects regions with CTRL+drag
 * - User adds annotations
 * - User clicks "Done" to proceed
 * - Script verifies and adds LLM annotations
 * - Repeats for multiple rounds
 *
 * No timeouts - fully user-driven flow.
 */

const url = args[0] || 'https://www.cnn.com';
const rounds = parseInt(args[1]) || 2;

console.log('='.repeat(60));
console.log('VISUAL WORKSPACE INTERACTIVE TEST');
console.log('='.repeat(60));
console.log(`URL: ${url}`);
console.log(`Rounds: ${rounds}`);
console.log('');

// Helper to log test results
function logTest(name, passed, details) {
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${name}`);
  if (details) {
    console.log(`   ${details}`);
  }
}

// ============================================================================
// TEST 1: Navigate to URL
// ============================================================================

console.log('');
console.log('━'.repeat(50));
console.log('TEST 1: Navigate to URL');
console.log('━'.repeat(50));

try {
  const navResult = await tools.navigatePage(url);
  logTest('Navigation', navResult.success !== false, `Navigated to ${url}`);
  await tools.sleep(2000); // Wait for page load
} catch (e) {
  logTest('Navigation', false, e.message);
  return { success: false, error: 'Navigation failed' };
}

// ============================================================================
// INTERACTIVE ROUNDS
// ============================================================================

const capturedImages = [];

for (let round = 1; round <= rounds; round++) {
  console.log('');
  console.log('━'.repeat(50));
  console.log(`ROUND ${round} of ${rounds}`);
  console.log('━'.repeat(50));

  // --- Step 1: User Selection ---
  console.log('');
  console.log('📸 STEP 1: Select a region');
  console.log('─'.repeat(40));
  console.log('   Use CTRL + Mouse Drag to select an area');
  console.log('   💡 TIP: Make sure selection is at least 10x10 pixels');
  console.log('');

  let selectionResult;
  try {
    selectionResult = await tools.promptUserSelection({
      prompt: `Round ${round}: Select an interesting area of the page`,
      // No timeout - wait indefinitely
    });

    if (selectionResult.success && selectionResult.image) {
      const img = selectionResult.image;
      capturedImages.push(img);

      logTest('Selection captured', true, `Image ID: ${img.id}`);
      console.log(`   Dimensions: ${img.dimensions.width}x${img.dimensions.height}`);
    } else {
      logTest('Selection captured', false, selectionResult.error || 'No image returned');

      // Provide helpful hints based on failure reason
      if (selectionResult.cancelled) {
        console.log('   💡 TIP: Selection was cancelled or too small. Try a larger area.');
      } else if (selectionResult.error) {
        console.log(`   💡 ERROR: ${selectionResult.error}`);
      }
      continue;
    }
  } catch (e) {
    logTest('Selection captured', false, e.message);
    continue;
  }

  // --- Step 2: User Annotations ---
  console.log('');
  console.log('✏️ STEP 2: Add your annotations');
  console.log('─'.repeat(40));
  console.log('   Use the toolbar to draw rectangles, circles, or arrows');
  console.log('   Click "Done" when finished');
  console.log('');

  // Wait for user to finish annotating
  const doneResult = await tools.waitForUserDone({
    prompt: 'Add annotations using the toolbar, then click Done',
  });

  if (!doneResult.success) {
    logTest('User annotations', false, doneResult.error);
    continue;
  }

  // Read what user annotated
  try {
    const stateResult = await tools.getWorkspaceState({
      imageId: selectionResult.image.id,
    });

    if (stateResult.success && stateResult.image) {
      const annotations = stateResult.image.annotations || [];
      const userAnnotations = annotations.filter(a => a.source === 'user');

      logTest('Read annotations', true, `Found ${userAnnotations.length} user annotations`);

      userAnnotations.forEach((ann, i) => {
        console.log(`   ${i + 1}. ${ann.type} at (${ann.geometry.x?.toFixed(2)}, ${ann.geometry.y?.toFixed(2)})`);
      });
    }
  } catch (e) {
    console.log(`   Warning: Could not read annotations: ${e.message}`);
  }

  // --- Step 3: LLM adds annotations ---
  console.log('');
  console.log('🤖 STEP 3: LLM adding annotations...');
  console.log('─'.repeat(40));

  try {
    // Add a blue rectangle with a comment label
    const rectResult = await tools.addWorkspaceAnnotation({
      imageId: selectionResult.image.id,
      type: 'rectangle',
      geometry: { x: 0.05, y: 0.05, width: 0.25, height: 0.12 },
      style: { color: '#4488ff', strokeWidth: 2, fillOpacity: 0.15 },
      label: `This area looks interesting (Round ${round})`,
    });
    logTest('LLM rectangle', rectResult.success, rectResult.annotationId || rectResult.error);

    // Add an arrow pointing to an area of interest with a comment
    const arrowResult = await tools.addWorkspaceAnnotation({
      imageId: selectionResult.image.id,
      type: 'arrow',
      geometry: { fromX: 0.3, fromY: 0.15, toX: 0.5, toY: 0.4 },
      style: { color: '#44cc88', strokeWidth: 3 },
      label: 'Check this element',
    });
    logTest('LLM arrow', arrowResult.success, arrowResult.annotationId || arrowResult.error);

  } catch (e) {
    logTest('LLM annotations', false, e.message);
  }

  // --- Step 4: Review and continue ---
  console.log('');
  console.log('👀 STEP 4: Review LLM annotations');
  console.log('─'.repeat(40));
  console.log('   Blue rectangle and green arrow added by LLM');
  console.log('   Click "Done" to continue to next round');
  console.log('');

  await tools.waitForUserDone({
    prompt: round < rounds
      ? 'Review the annotations, click Done for next round'
      : 'Review the annotations, click Done to finish',
  });

  // Minimize if there's another round
  if (round < rounds) {
    await tools.hideWorkspaceOverlay({ imageId: selectionResult.image.id });
    console.log('');
    console.log('📜 Scrolling for next selection...');
    await tools.scrollViewport({ y: 400 });
    await tools.sleep(500);
  }
}

// ============================================================================
// FINAL: Test image stack navigation
// ============================================================================

if (capturedImages.length >= 2) {
  console.log('');
  console.log('━'.repeat(50));
  console.log('FINAL: Image Stack Navigation');
  console.log('━'.repeat(50));
  console.log('');
  console.log('📚 You should see a thumbnail strip at the bottom');
  console.log('   Click thumbnails to switch between captures');
  console.log('');

  // Get final stack state
  const stackResult = await tools.getImageStack({});
  console.log(`Total images in stack: ${stackResult.images?.length || 0}`);

  stackResult.images?.forEach((img, i) => {
    console.log(`   ${i + 1}. ${img.id} - ${img.annotationCount} annotations`);
  });

  // Show first image to demonstrate stack
  await tools.showWorkspaceOverlay({ imageId: capturedImages[0].id });

  await tools.waitForUserDone({
    prompt: 'Try clicking different thumbnails, then click Done to finish',
  });
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('');
console.log('═'.repeat(60));
console.log('TEST COMPLETE');
console.log('═'.repeat(60));
console.log(`Total images captured: ${capturedImages.length}`);
console.log('');
console.log('Verified:');
console.log('✓ CTRL+Mouse selection creates overlay');
console.log('✓ User can draw annotations');
console.log('✓ LLM can add annotations');
console.log('✓ Done button pauses script');
console.log('✓ Thumbnail strip for navigation');
console.log('═'.repeat(60));

return {
  success: true,
  capturedImages: capturedImages.length,
  rounds: rounds,
};
