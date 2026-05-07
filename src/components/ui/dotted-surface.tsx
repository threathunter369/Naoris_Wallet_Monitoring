import { cn } from '../../lib/utils';
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

type DottedSurfaceProps = Omit<React.ComponentProps<'div'>, 'ref'>;

export function DottedSurface({ className, ...props }: DottedSurfaceProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const sceneRef = useRef<{
		scene: THREE.Scene;
		camera: THREE.PerspectiveCamera;
		renderer: THREE.WebGLRenderer;
		particles: THREE.Points[];
		animationId: number;
		count: number;
	} | null>(null);

	useEffect(() => {
		const currentContainer = containerRef.current;
		if (!currentContainer) return;

		// Clear any existing canvases (handles React Strict Mode double-invocations perfectly)
		// This prevents a static 'ghost' canvas from overlapping the active animating one.
		while (currentContainer.firstChild) {
			currentContainer.removeChild(currentContainer.firstChild);
		}

		const SEPARATION = 150;
		const AMOUNTX = 40;
		const AMOUNTY = 60;

		// Scene setup
		const scene = new THREE.Scene();
		scene.fog = new THREE.Fog(0x050505, 2000, 10000);

		const camera = new THREE.PerspectiveCamera(
			60,
			window.innerWidth / window.innerHeight,
			1,
			10000,
		);
		camera.position.set(0, 355, 1220);

		const renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: true,
		});
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setSize(window.innerWidth, window.innerHeight);
		renderer.setClearColor(0x000000, 0);

		currentContainer.appendChild(renderer.domElement);

		// Create particles
		const positions: number[] = [];
		const colors: number[] = [];

		const geometry = new THREE.BufferGeometry();

		for (let ix = 0; ix < AMOUNTX; ix++) {
			for (let iy = 0; iy < AMOUNTY; iy++) {
				const x = ix * SEPARATION - (AMOUNTX * SEPARATION) / 2;
				const y = 0; // Will be animated
				const z = iy * SEPARATION - (AMOUNTY * SEPARATION) / 2;

				positions.push(x, y, z);
				// Using a faint green color to match Naoris brand, normalized to 0-1
				colors.push(0, 1, 65 / 255);
			}
		}

		const positionAttribute = new THREE.Float32BufferAttribute(positions, 3);
		positionAttribute.setUsage(THREE.DynamicDrawUsage);
		geometry.setAttribute('position', positionAttribute);
		
		geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

		// Create material
		const material = new THREE.PointsMaterial({
			size: 8,
			vertexColors: true,
			transparent: true,
			opacity: 0.3,
			sizeAttenuation: true,
		});

		// Create points object
		const points = new THREE.Points(geometry, material);
		scene.add(points);

		let animationId: number;
		const clock = new THREE.Clock();

		// Animation function
		const animate = () => {
			animationId = requestAnimationFrame(animate);

			const elapsedTime = clock.getElapsedTime();
			// Multiply by 6 to match original speed (0.1 per frame at 60fps = 6 per second)
			const count = elapsedTime * 6;

			const posAttr = geometry.attributes.position as THREE.BufferAttribute;
			const positionsArray = posAttr.array as Float32Array;

			let i = 0;
			for (let ix = 0; ix < AMOUNTX; ix++) {
				for (let iy = 0; iy < AMOUNTY; iy++) {
					const index = i * 3;

					// Animate Y position with sine waves
					positionsArray[index + 1] =
						Math.sin((ix + count) * 0.3) * 50 +
						Math.sin((iy + count) * 0.5) * 50;

					i++;
				}
			}

			posAttr.needsUpdate = true;
			renderer.render(scene, camera);
		};

		// Handle window resize
		const handleResize = () => {
			camera.aspect = window.innerWidth / window.innerHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(window.innerWidth, window.innerHeight);
		};

		window.addEventListener('resize', handleResize);

		// Start animation
		animate();

		// Cleanup function
		return () => {
			window.removeEventListener('resize', handleResize);
			cancelAnimationFrame(animationId);

			// Clean up Three.js objects
			scene.traverse((object) => {
				if (object instanceof THREE.Points) {
					object.geometry.dispose();
					if (Array.isArray(object.material)) {
						object.material.forEach((material) => material.dispose());
					} else {
						object.material.dispose();
					}
				}
			});

			renderer.dispose();

			if (currentContainer && renderer.domElement) {
				if (currentContainer.contains(renderer.domElement)) {
					currentContainer.removeChild(renderer.domElement);
				}
			}
		};
	}, []);

	return (
		<div
			ref={containerRef}
			className={cn('pointer-events-none fixed inset-0 z-0', className)}
			{...props}
		/>
	);
}
