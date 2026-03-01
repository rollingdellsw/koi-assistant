// skills/osd-controller/mcp/osd_mcp.js
// OpenSeadragon MCP Server

return {
  listTools() {
    return [
      {
        name: "osd_get_status",
        description: "Get viewer status including zoom level and viewport bounds",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: "osd_zoom",
        description: "Zoom the viewer to a specific level",
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "number",
              description: "Zoom level (absolute) or multiplier (relative)"
            },
            relative: {
              type: "boolean",
              description: "If true, multiply current zoom by level"
            }
          },
          required: ["level"],
          additionalProperties: false
        }
      },
      {
        name: "osd_pan",
        description: "Pan the viewer viewport",
        inputSchema: {
          type: "object",
          properties: {
            dx: {
              type: "number",
              description: "Horizontal delta in viewport coordinates"
            },
            dy: {
              type: "number",
              description: "Vertical delta in viewport coordinates"
            }
          },
          required: ["dx", "dy"],
          additionalProperties: false
        }
      }
    ];
  },

  // Handle management
  _handle: null,

  async getViewer() {
    if (this._handle) return this._handle;

    // Use static finder instead of dynamic code
    const res = await runtime.acquireHandle('openseadragon_viewer', {});
    if (res.error) {
      throw new Error(`Viewer not found: ${res.error}. Diagnostics: ${res.diagnostics ? res.diagnostics.join(', ') : 'none'}`);
    }
    this._handle = res.handleId;
    return this._handle;
  },

  async callTool(name, args) {
    try {
      const handle = await this.getViewer();

      if (name === "osd_get_status") {
        const zoomVal = await runtime.invokeOnHandle(handle, "viewport.getZoom", []);
        const bounds = await runtime.invokeOnHandle(handle, "viewport.getBounds", []);
        return {
          content: [{ type: "text", text: JSON.stringify({ zoom: zoomVal.result, bounds: bounds.result }, null, 2) }]
        };
      } else if (name === "osd_zoom") {
        // Calculate target zoom
        const curZoom = await runtime.invokeOnHandle(handle, "viewport.getZoom", []);
        const target = args.relative ? (curZoom.result * args.level) : args.level;
        const res = await runtime.invokeOnHandle(handle, "viewport.zoomTo", [target]);
        return { content: [{ type: "text", text: JSON.stringify({ zoom: target }) }] };
      } else if (name === "osd_pan") {
        // PanBy takes {x,y}
        const res = await runtime.invokeOnHandle(handle, "viewport.panBy", [{ x: args.dx, y: args.dy }]);
        return { content: [{ type: "text", text: JSON.stringify({ panned: true }) }] };
      }

      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    } catch (e) {
      // If handle is stale, clear it for next time
      this._handle = null;
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
};
