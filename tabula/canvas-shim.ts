// Simple canvas shim for Deno
// This provides a minimal implementation to prevent errors when LinkedOM tries to use canvas

export default {
  // Provide minimal implementations of required canvas functionality
  createCanvas: () => ({
    getContext: () => ({
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      fillRect: () => {},
      drawImage: () => {},
    }),
    width: 0,
    height: 0,
    toBuffer: () => new Uint8Array(),
    toDataURL: () => "data:,",
  }),
  
  // Image constructor shim
  Image: class {
    width = 0;
    height = 0;
    src = "";
    onload = () => {};
    onerror = () => {};
  },
  
  // Add any other required canvas functionality here
};