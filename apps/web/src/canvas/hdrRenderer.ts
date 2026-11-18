import shader from './selectionHdr.wgsl?raw';

export interface HdrShape {
  x: number; y: number; width: number; height: number;
  radius: number; strength: number; opacity: number; spread: number;
}

const format = 'rgba16float';
const stride = 32;
const over: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };
const erase: GPUBlendComponent = { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' };

export async function createHdrRenderer(canvas: HTMLCanvasElement) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('WebGPU canvas unavailable');
  }
  try {
    device.pushErrorScope('validation');
    context.configure({ device, format, alphaMode: 'premultiplied', toneMapping: { mode: 'extended' } });
    const configurationError = await device.popErrorScope();
    if (configurationError || context.getConfiguration?.()?.toneMapping?.mode !== 'extended') {
      throw new Error('Extended canvas unavailable');
    }

    const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uniformData = new Float32Array(4);
    const bindings = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings] });
    const bindGroup = device.createBindGroup({ layout: bindings, entries: [{ binding: 0, resource: { buffer: uniforms } }] });
    const module = device.createShaderModule({ code: shader });
    const pipeline = (entryPoint: string, blend: GPUBlendComponent) => device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'vertex', buffers: [{ arrayStride: stride, stepMode: 'instance', attributes: [
        { format: 'float32x4', offset: 0, shaderLocation: 0 },
        { format: 'float32x4', offset: 16, shaderLocation: 1 },
      ] }] },
      fragment: { module, entryPoint, targets: [{ format, blend: { color: blend, alpha: blend } }] },
      primitive: { topology: 'triangle-list' },
    });
    const [light, mask] = await Promise.all([pipeline('light', over), pipeline('mask', erase)]);
    const renderError = new Promise<void>(resolve => {
      device.addEventListener('uncapturederror', event => { event.preventDefault(); resolve(); }, { once: true });
    });
    let capacity = 0;
    let vertices: GPUBuffer | undefined;
    let instanceData = new Float32Array(0);
    return {
      failed: Promise.race([device.lost, renderError]),
      draw(shapes: HdrShape[], width: number, height: number, strength: number, dark: boolean) {
        const maxSize = device.limits.maxTextureDimension2D;
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(4_000_000 / (width * height)), maxSize / width, maxSize / height);
        const pixelWidth = Math.max(1, Math.floor(width * ratio)), pixelHeight = Math.max(1, Math.floor(height * ratio));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        if (!vertices || capacity < shapes.length) {
          vertices?.destroy();
          capacity = Math.max(shapes.length, capacity * 2, 32);
          vertices = device.createBuffer({ size: capacity * stride, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          instanceData = new Float32Array(capacity * stride / 4);
        }
        for (let i = 0; i < shapes.length; i++) {
          const { x, y, width, height, radius, strength, opacity, spread } = shapes[i];
          instanceData.set([x, y, width, height, radius, strength, opacity, spread], i * stride / 4);
        }
        uniformData.set([width, height, strength / 100, Number(dark)]);
        device.queue.writeBuffer(uniforms, 0, uniformData);
        device.queue.writeBuffer(vertices, 0, instanceData, 0, shapes.length * stride / 4);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
          view: context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store',
        }] });
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, vertices);
        for (let start = 0; start < shapes.length;) {
          const luminous = shapes[start].strength > 0;
          let end = start + 1;
          while (end < shapes.length && (shapes[end].strength > 0) === luminous) end++;
          pass.setPipeline(luminous ? light : mask);
          pass.draw(luminous ? 24 : 6, end - start, 0, start);
          start = end;
        }
        pass.end();
        device.queue.submit([encoder.finish()]);
      },
      release() {
        context.unconfigure();
        device.destroy();
      },
    };
  } catch (error) {
    context.unconfigure();
    device.destroy();
    throw error;
  }
}
