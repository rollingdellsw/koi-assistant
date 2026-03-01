(function findViewerByClimbing() {
console.log("🧗 Starting Recursive DOM Climber...");

    // 1. Start at the element you found
    let el = document.querySelector('#osd > div > div.openseadragon-canvas');
    if (!el) {
        console.error("❌ Original element not found. Please re-highlight it or reload.");
        return;
    }

    // 2. Helper: Is this object the OSD Viewer?
    function isViewer(obj) {
        // Checks for the signature 'viewport' and 'world' properties of OSD
        return obj &&
               typeof obj === 'object' &&
               obj.viewport &&
               obj.world &&
               typeof obj.viewport.zoomTo === 'function';
    }

    // 3. Loop: Climb up the DOM tree one parent at a time
    let foundViewer = null;
    let currentDOMNode = el;

    while (currentDOMNode && currentDOMNode !== document.body) {
        console.log(`Checking DOM Node: <${currentDOMNode.tagName.toLowerCase()} id="${currentDOMNode.id}" class="${currentDOMNode.className}">`);

        // A. Does this DOM node have React attached?
        const reactKey = Object.keys(currentDOMNode).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternal'));

        if (reactKey) {
            console.log("   ↳ ✅ Found React Data! Inspecting component state...");
            let fiber = currentDOMNode[reactKey];
            let depth = 0;

            // B. Traverse the React Fiber tree for this node
            while (fiber && depth < 5) { // Check 5 layers of React wrapping
                // Check all possible hiding spots
                const candidates = [
                    fiber.stateNode,                 // Class Component
                    fiber.memoizedProps,             // Props
                    fiber.memoizedProps?.viewer,     // Common prop
                    fiber.stateNode?.viewer,         // Common class prop
                    fiber.memoizedState              // Hooks state
                ];

                // If 'memoizedState' is an object (Hooks), check its properties
                if (fiber.memoizedState && typeof fiber.memoizedState === 'object') {
                    candidates.push(fiber.memoizedState.memoizedState); // React internal hook storage
                }

                for (let item of candidates) {
                    // Direct match?
                    if (isViewer(item)) {
                        foundViewer = item;
                        break;
                    }
                    // Wrapped in Ref? { current: viewer }
                    if (item && isViewer(item.current)) {
                        foundViewer = item.current;
                        break;
                    }
                }

                if (foundViewer) break;
                fiber = fiber.return; // Move to React parent
                depth++;
            }
        }

        if (foundViewer) {
            console.log(`🎉 SUCCESS! Viewer found on ancestor: <${currentDOMNode.tagName.toLowerCase()}>`);
            break;
        }

        // Move up to the next HTML parent
        currentDOMNode = currentDOMNode.parentElement;
    }

    // 4. Final Result
    if (foundViewer) {
        window.viewer = foundViewer;
        console.log("%c✅ Viewer saved to 'window.viewer'", "color: lime; font-size: 16px; font-weight: bold;");
        console.log("Current Zoom:", window.viewer.viewport.getZoom());
        console.log("🚀 Attempting Zoom in 3 seconds...");
        setTimeout(() => {
            window.viewer.viewport.zoomBy(1.5);
            console.log("Zoom command sent.");
        }, 1000);
    } else {
        console.error("❌ Climbed all the way to BODY and didn't find the viewer.");
    }

})();
