"""Build Labora's editable character meshes and portable glTF/USDZ assets.

blender --background --factory-startup --python scripts/blender-characters.py
"""

import argparse
import hashlib
import json
import math
import random
import struct
import sys
import zipfile
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "characters3d"
TAU = math.tau
SPECS = {
    "star": {"material": "Hand-worked yellow clay", "color": "FFD05A", "roughness": 0.72, "metallic": 0.0, "noise": 95, "bump": 0.0007},
    "cube": {"material": "Blue frosted glass", "color": "7BA9E6", "roughness": 0.50, "metallic": 0.0, "noise": 140, "bump": 0.0005},
    "hexagon": {"material": "Green brushed metal", "color": "88C5A9", "roughness": 0.51, "metallic": 0.65, "noise": 1, "bump": 0.00015},
    "spark": {"material": "Lavender matte silicone", "color": "BCA6E3", "roughness": 0.76, "metallic": 0.0, "noise": 130, "bump": 0.0005},
    "pyramid": {"material": "Coral glazed ceramic", "color": "EE9682", "roughness": 0.28, "metallic": 0.0, "noise": 72, "bump": 0.0005},
    "pebble": {"material": "Ivory felt", "color": "F1E5D0", "roughness": 0.94, "metallic": 0.0, "noise": 180, "bump": 0.0018},
}


def rgba(hex_color):
    values = [int(hex_color[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    return tuple(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in values) + (1.0,)


def material(name, hex_color, roughness=0.5, metallic=0.0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba(hex_color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    result.diffuse_color = rgba(hex_color)
    return result, shader


def body_material(name):
    spec = SPECS[name]
    result, shader = material(spec["material"], spec["color"], spec["roughness"], spec["metallic"])
    nodes, links = result.node_tree.nodes, result.node_tree.links
    coords = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = spec["noise"]
    noise.inputs["Detail"].default_value = 3
    links.new(coords.outputs["Generated"], noise.inputs["Vector"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.42
    bump.inputs["Distance"].default_value = spec["bump"]
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    if name == "hexagon":
        scale = nodes.new("ShaderNodeVectorMath")
        scale.operation = "MULTIPLY"
        scale.inputs[1].default_value = (2, 2, 220)
        links.new(coords.outputs["Generated"], scale.inputs[0])
        links.new(scale.outputs["Vector"], noise.inputs["Vector"])
        shader.inputs["Anisotropic"].default_value = 0.25
    if name == "cube":
        shader.inputs["Transmission Weight"].default_value = 0.2
        shader.inputs["IOR"].default_value = 1.42
        shader.inputs["Coat Weight"].default_value = 0.10
        shader.inputs["Coat Roughness"].default_value = 0.4
    if name in ("star", "spark"):
        shader.inputs["Subsurface Weight"].default_value = 0.045
    if name == "pyramid":
        shader.inputs["Coat Weight"].default_value = 0.35
        shader.inputs["Coat Roughness"].default_value = 0.23
    if name == "pebble":
        shader.inputs["Sheen Weight"].default_value = 0.72
        shader.inputs["Sheen Roughness"].default_value = 0.8
    return result


def select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def mesh(name, vertices, faces):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data)
    bm.free()
    for polygon in data.polygons:
        polygon.use_smooth = True
    return obj


def soften_outline(points, iterations=3):
    for _ in range(iterations):
        next_points = []
        for index, point in enumerate(points):
            other = points[(index + 1) % len(points)]
            next_points.extend([(0.8 * point[0] + 0.2 * other[0], 0.8 * point[1] + 0.2 * other[1]), (0.2 * point[0] + 0.8 * other[0], 0.2 * point[1] + 0.8 * other[1])])
        points = next_points
    return points


def pillow(name, outline, depth):
    outline = soften_outline(outline)
    vertices, faces = [], []
    steps = 22
    rings = [(math.sin((i + 1) * math.pi / (2 * steps)), -math.cos((i + 1) * math.pi / (2 * steps))) for i in range(steps)]
    rings += [(math.cos((i + 1) * math.pi / (2 * steps)), math.sin((i + 1) * math.pi / (2 * steps))) for i in range(steps - 1)]
    count = len(outline)
    for scale, y in rings:
        for x, z in outline:
            vertices.append((x * scale, y * depth / 2, z * scale))
    for ring in range(len(rings) - 1):
        for i in range(count):
            j = (i + 1) % count
            faces.append((ring * count + i, ring * count + j, (ring + 1) * count + j, (ring + 1) * count + i))
    for ring, y in [(0, -depth / 2), (len(rings) - 1, depth / 2)]:
        pole = len(vertices)
        vertices.append((0, y, 0))
        for i in range(count):
            faces.append((pole, ring * count + i, ring * count + (i + 1) % count))
    return mesh(name, vertices, faces)


def bevel(obj, width, segments=8):
    modifier = obj.modifiers.new("Soft sculpted edges", "BEVEL")
    modifier.width, modifier.segments = width, segments
    modifier.limit_method = "ANGLE"
    select([obj])
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    modifier = obj.modifiers.new("Weighted corner normals", "WEIGHTED_NORMAL")
    modifier.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def make_body(name):
    if name == "star":
        points = [(math.sin(i * TAU / 10) * (1.26 if i % 2 == 0 else 0.75), math.cos(i * TAU / 10) * (1.26 if i % 2 == 0 else 0.75)) for i in range(10)]
        return pillow("Star · clay body", points, 1.04)
    if name == "spark":
        return pillow("Spark · silicone body", [(0, 1.29), (0.50, 0.45), (1.12, 0), (0.50, -0.45), (0, -1.27), (-0.50, -0.45), (-1.12, 0), (-0.50, 0.45)], 1.0)
    if name == "hexagon":
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=1.12, depth=0.78, rotation=(math.pi / 2, 0, 0))
        obj = bpy.context.object
        obj.name = "Hexagon · brushed metal body"
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        bevel(obj, 0.17, 12)
        return obj
    if name == "cube":
        bpy.ops.mesh.primitive_cube_add(size=1.8)
        obj = bpy.context.object
        obj.name = "Cube · frosted glass body"
        bevel(obj, 0.34, 14)
        return obj
    if name == "pyramid":
        obj = mesh("Pyramid · glazed ceramic body", [(-1.10, -0.47, -0.87), (1.10, -0.47, -0.87), (0, -0.47, 1.16), (0, 1.0, -0.73)], [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)])
        bevel(obj, 0.22, 12)
        return obj
    bpy.ops.mesh.primitive_uv_sphere_add(segments=80, ring_count=48)
    obj = bpy.context.object
    obj.name = "Pebble · felt body"
    for vertex in obj.data.vertices:
        x, y, z = vertex.co
        vertex.co = (1.08 * x * (1 - 0.09 * z) + 0.06 * z * z, 0.73 * y * (1 + 0.035 * x), 0.97 * z + 0.04 * x)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def surface_y(body, x, z):
    hit, position, _, _ = body.ray_cast(Vector((x, -5, z)), Vector((0, 1, 0)))
    if not hit:
        raise RuntimeError(f"Face point is outside {body.name}: {x}, {z}")
    return position.y


def ellipsoid(name, location, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=24, location=location)
    obj = bpy.context.object
    obj.name, obj.scale = name, scale
    select([obj])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.materials.append(mat)
    return obj


def surface_oval(name, body, x, z, width, height, depth, offset, mat):
    y = surface_y(body, x, z)
    obj = ellipsoid(name, (x, y + offset, z), (width, depth, height), mat)
    for vertex in obj.data.vertices:
        vertex.co.y += surface_y(body, x + vertex.co.x, z + vertex.co.z) - y
    return obj


def add_eyes(name, body):
    dark, shader = material("Espresso cartoon eyes", "40332B", 0.72)
    shader.inputs["Specular IOR Level"].default_value = 0
    shader.inputs["Coat Weight"].default_value = 0
    white, shader = material("Single cream catchlight", "EADDC4", 0.8)
    shader.inputs["Specular IOR Level"].default_value = 0
    face_z = -0.20 if name == "pyramid" else -0.055
    spacing = 0.165 if name == "spark" else 0.175
    eye_size = 0.085 if name == "spark" else 0.09
    parts = []
    for i, x in enumerate((-spacing, spacing)):
        side = "L" if i == 0 else "R"
        eye = surface_oval(f"Eye {side}", body, x, face_z, eye_size, 0.132 if name == "spark" else 0.137, 0.018, 0.002, dark)
        parts.append(eye)
        catchlight = surface_oval(f"Catchlight {side}", body, x - 0.023, face_z + 0.043, 0.015, 0.019, 0.005, -0.016, white)
        parts.append(catchlight)
    return parts


def add_felt(body):
    random.seed(19)
    vertices, faces = [], []
    for _ in range(1800):
        z = random.uniform(-1, 1)
        angle = random.uniform(0, TAU)
        radial = math.sqrt(1 - z * z)
        normal = Vector((radial * math.cos(angle), radial * math.sin(angle), z))
        direction = normal.normalized()
        hit, point, normal, _ = body.ray_cast(direction * 3, -direction)
        if not hit:
            continue
        tangent = normal.cross(Vector((0, 0, 1)))
        if tangent.length < 0.1:
            tangent = normal.cross(Vector((1, 0, 0)))
        tangent.normalize()
        tangent2 = normal.cross(tangent).normalized()
        length = random.uniform(0.008, 0.016)
        lean = tangent * random.uniform(-0.005, 0.005) + tangent2 * random.uniform(-0.005, 0.005)
        start = len(vertices)
        for level in range(3):
            center = point + normal * (length * level / 2 - 0.001) + lean * (level / 2) ** 2
            radius = 0.0015 * (1 - level * 0.24)
            for side in range(4):
                offset = radius * (tangent * math.cos(side * TAU / 4) + tangent2 * math.sin(side * TAU / 4))
                vertices.append(tuple(center + offset))
        for level in range(2):
            for side in range(4):
                other = (side + 1) % 4
                faces.append((start + level * 4 + side, start + level * 4 + other, start + (level + 1) * 4 + other, start + (level + 1) * 4 + side))
        faces.extend([(start + 3, start + 2, start + 1, start), (start + 8, start + 9, start + 10, start + 11)])
    obj = mesh("Felt fibres · 1800 individual solid strands", vertices, faces)
    mat, shader = material("Ivory felt fibres", "F4EBDC", 0.96)
    shader.inputs["Sheen Weight"].default_value = 0.8
    obj.data.materials.append(mat)
    return obj


def bake_normal(body, path):
    select([body])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.03)
    bpy.ops.object.mode_set(mode="OBJECT")
    mat = body.data.materials[0]
    source = mat.copy()
    source.name = f"{mat.name} · editable procedural source"
    source.use_fake_user = True
    image = bpy.data.images.new(f"{body.name} · baked surface normal", width=512, height=512, alpha=False)
    image.colorspace_settings.name = "Non-Color"
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    mat.node_tree.nodes.active = node
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.render.bake.margin = 8
    bpy.ops.object.bake(type="NORMAL")
    image.filepath_raw, image.file_format = str(path), "PNG"
    image.save()
    normal = mat.node_tree.nodes.new("ShaderNodeNormalMap")
    mat.node_tree.links.new(node.outputs["Color"], normal.inputs["Color"])
    mat.node_tree.links.new(normal.outputs["Normal"], mat.node_tree.nodes.get("Principled BSDF").inputs["Normal"])
    image.pack()


def lighting():
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new("Soft studio")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.43, 0.49, 0.60, 1)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.45
    for name, location, power, size in [("Large warm key", (-3.5, -4.5, 5), 580, 4), ("Soft fill", (4, -3, 1.5), 320, 3.5), ("Edge light", (2, 3, 4), 650, 3)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        obj = bpy.context.object
        obj.name, obj.data.energy, obj.data.shape, obj.data.size = name, power, "DISK", size
        obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add(location=(2.1, -8, 1.65))
    camera = bpy.context.object
    camera.name = "Character portrait"
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type, camera.data.ortho_scale = "ORTHO", 2.8
    scene.camera = camera
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"


def mesh_metrics(objects):
    result = {"meshObjects": len(objects), "vertices": 0, "triangles": 0, "nonManifoldEdges": 0}
    for obj in objects:
        obj.data.calc_loop_triangles()
        result["vertices"] += len(obj.data.vertices)
        result["triangles"] += len(obj.data.loop_triangles)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        non_manifold = sum(not edge.is_manifold for edge in bm.edges)
        result["nonManifoldEdges"] += non_manifold
        if non_manifold:
            print(f"NON_MANIFOLD {obj.name} {non_manifold}", flush=True)
        bm.free()
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    result["bounds"] = {"min": [min(point[axis] for point in points) for axis in range(3)], "max": [max(point[axis] for point in points) for axis in range(3)]}
    return result


def build(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    directory = OUTPUT / name
    directory.mkdir(parents=True, exist_ok=True)
    body = make_body(name)
    body.data.materials.append(body_material(name))
    bake_normal(body, directory / "surface-normal.png")
    parts = [body, *add_eyes(name, body)]
    if name == "pebble":
        parts.append(add_felt(body))
    for obj in parts:
        obj["labora_character"] = name
        obj["role"] = "body" if obj == body else "face_or_fibre_geometry"
    bpy.context.view_layer.update()
    metrics = mesh_metrics(parts)
    metrics["face"] = {"style": "Small shallow matte cartoon eyes", "eyes": 2, "catchlights": 2, "mouth": False, "eyebrow": False, "eyeWidthRadius": 0.085 if name == "spark" else 0.09, "eyeHeightRadius": 0.132 if name == "spark" else 0.137, "eyeCenterSpacing": 0.33 if name == "spark" else 0.35, "maximumEyeProtrusion": 0.016}
    if metrics["nonManifoldEdges"]:
        raise RuntimeError(f"{name} contains nonmanifold geometry")
    select(parts)
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT / f"{name}.glb"), export_format="GLB", use_selection=True, export_apply=True, export_animations=False, export_cameras=False, export_lights=False)
    bpy.ops.wm.usd_export(filepath=str(OUTPUT / f"{name}.usdz"), selected_objects_only=True, export_animation=False, export_materials=True, generate_preview_surface=True, export_textures_mode="NEW", overwrite_textures=True, export_lights=False, export_cameras=False, convert_world_material=False, convert_orientation=True, export_global_forward_selection="NEGATIVE_Z", export_global_up_selection="Y")
    lighting()
    select([body])
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT / f"{name}.blend"))
    bpy.context.scene.render.filepath = str(directory / "preview.png")
    bpy.ops.render.render(write_still=True)
    metrics.update({"name": name, "material": SPECS[name]["material"], "files": {extension: f"{name}.{extension}" for extension in ("blend", "glb", "usdz")}, "preview": f"{name}/preview.png", "normalTexture": f"{name}/surface-normal.png", "blenderVersion": bpy.app.version_string, "sourceFront": "-Y", "sourceUp": "+Z", "exportUp": "+Y", "gltfFront": "+Z", "initialCameraOrbit": "15deg 78deg 105%"})
    (directory / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(f"LABORA_CHARACTER_COMPLETE {name} {metrics['triangles']} triangles", flush=True)


def contact_sheet():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for index, name in enumerate(SPECS):
        path = OUTPUT / f"{name}.blend"
        with bpy.data.libraries.load(str(path), link=False) as (source, target):
            target.objects = [obj for obj in source.objects]
        for obj in target.objects:
            if obj and obj.type == "MESH":
                bpy.context.collection.objects.link(obj)
                obj.location.x += (index % 3 - 1) * 2.8
                obj.location.z += 1.6 - (index // 3) * 3.0
        bpy.ops.object.text_add(location=((index % 3 - 1) * 2.8, -0.1, 0.26 - (index // 3) * 3.0), rotation=(math.pi / 2, 0, 0))
        text = bpy.context.object
        text.data.body, text.data.align_x, text.data.size = f"{name.capitalize()} / {SPECS[name]['material']}", "CENTER", 0.14
        text.data.materials.append(material(f"{name} caption", "EDEDE8", 1)[0])
    lighting()
    scene = bpy.context.scene
    scene.camera.location = (0, -18, 2.3)
    scene.camera.rotation_euler = (Vector((0, 0, 0.25)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera.data.ortho_scale = 8.8
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1200
    scene.render.film_transparent = False
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.055, 0.065, 0.08, 1)
    scene.render.filepath = str(OUTPUT / "contact-sheet.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT / "labora-characters.blend"))
    bpy.ops.render.render(write_still=True)
    manifest = {"generator": "scripts/blender-characters.py", "blenderVersion": bpy.app.version_string, "generatedFrom": "Procedural meshes; no reference PNGs used as geometry or color textures", "characters": [json.loads((OUTPUT / name / "metrics.json").read_text()) for name in SPECS]}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def turnaround():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for row, name in enumerate(SPECS):
        for column, angle in enumerate((0, math.pi / 2, math.pi)):
            with bpy.data.libraries.load(str(OUTPUT / f"{name}.blend"), link=False) as (source, target):
                target.objects = [obj for obj in source.objects]
            for obj in target.objects:
                if obj and obj.type == "MESH":
                    bpy.context.collection.objects.link(obj)
                    obj.matrix_world = Matrix.Translation(((column - 1) * 2.7, 0, 6.8 - row * 2.65)) @ Matrix.Rotation(angle, 4, "Z") @ obj.matrix_basis
    lighting()
    scene = bpy.context.scene
    scene.camera.location = (0, -24, 0.4)
    scene.camera.rotation_euler = (Vector((0, 0, 0.4)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera.data.ortho_scale = 16.9
    scene.render.resolution_x, scene.render.resolution_y = 1200, 2200
    scene.cycles.samples = 24
    scene.render.film_transparent = False
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.055, 0.065, 0.08, 1)
    scene.render.filepath = str(OUTPUT / "turnaround.png")
    bpy.ops.render.render(write_still=True)


def validate_exports():
    from pxr import Usd, UsdGeom

    checks = []
    for name in SPECS:
        metrics = json.loads((OUTPUT / name / "metrics.json").read_text())
        bpy.ops.wm.open_mainfile(filepath=str(OUTPUT / f"{name}.blend"))
        source = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        assert len(source) == metrics["meshObjects"]
        assert len(source) == (6 if name == "pebble" else 5)
        assert len([obj for obj in source if obj.name.startswith("Eye ")]) == 2
        assert len([obj for obj in source if obj.name.startswith("Catchlight ")]) == 2
        assert not any(word in obj.name.lower() for obj in source for word in ("smile", "mouth", "brow"))
        body = next(obj for obj in source if obj.get("role") == "body")
        for eye in (obj for obj in source if obj.name.startswith("Eye ")):
            points = [eye.matrix_world @ vertex.co for vertex in eye.data.vertices]
            protrusion = max(surface_y(body, point.x, point.z) - point.y for point in points)
            assert protrusion <= 0.0161, f"{name} eye is not shallow: {protrusion}"
            assert eye.dimensions.x <= 0.181, f"{name} eye width exceeds the approved proportion"
        assert mesh_metrics(source)["nonManifoldEdges"] == 0
        volumes = []
        for obj in source:
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            volumes.append(abs(bm.calc_volume()))
            bm.free()
        assert max(volumes) > 0.2, f"{name} has no volumetric body"
        assert all(volume > 0 for volume in volumes), f"{name} has flat geometry"
        packed = [image.name for image in bpy.data.images if image.packed_file]
        assert packed, f"{name} source normal texture is not packed"
        data = (OUTPUT / f"{name}.glb").read_bytes()
        magic, version, length = struct.unpack_from("<4sII", data)
        assert magic == b"glTF" and version == 2 and length == len(data)
        json_size = struct.unpack_from("<I", data, 12)[0]
        document = json.loads(data[20:20 + json_size])
        assert not document.get("cameras") and not document.get("animations")
        assert all("uri" not in image for image in document.get("images", []))
        assert all("uri" not in buffer for buffer in document.get("buffers", []))
        assert len(document["meshes"]) == metrics["meshObjects"]
        triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3 for mesh in document["meshes"] for primitive in mesh["primitives"])
        assert triangles == metrics["triangles"]
        assert all("baseColorTexture" not in mat.get("pbrMetallicRoughness", {}) for mat in document["materials"])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(OUTPUT / f"{name}.glb"))
        imported = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        assert len(imported) == metrics["meshObjects"]
        usd_path = OUTPUT / f"{name}.usdz"
        stage = Usd.Stage.Open(str(usd_path))
        assert stage and UsdGeom.GetStageUpAxis(stage) == "Y"
        meshes = [prim for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)]
        assert len(meshes) == metrics["meshObjects"]
        eyes = [prim for prim in stage.Traverse() if str(prim.GetName()) in ("Eye_L", "Eye_R")]
        assert len(eyes) == 2
        cache = UsdGeom.XformCache()
        assert all(cache.GetLocalToWorldTransform(eye).ExtractTranslation()[2] > 0 for eye in eyes)
        with zipfile.ZipFile(usd_path) as archive:
            assert any(path.startswith("textures/") for path in archive.namelist())
        checks.append({"character": name, "face": metrics["face"], "sourceManifold": True, "allComponentsHaveVolume": True, "sourceTexturesPacked": True, "glbReimportedMeshes": len(imported), "usdzMeshCount": len(meshes), "triangles": triangles, "exportUp": "+Y", "exportFront": "+Z", "noBillboardsOrBaseColorImages": True, "files": {extension: {"bytes": (OUTPUT / f"{name}.{extension}").stat().st_size, "sha256": hashlib.sha256((OUTPUT / f"{name}.{extension}").read_bytes()).hexdigest()} for extension in ("blend", "glb", "usdz")}})
        print(f"LABORA_CHARACTER_VERIFIED {name}", flush=True)
    (OUTPUT / "validation.json").write_text(json.dumps({"blenderVersion": bpy.app.version_string, "checks": checks}, indent=2) + "\n")


arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--only", choices=list(SPECS))
parser.add_argument("--contact-sheet", action="store_true")
parser.add_argument("--turnaround", action="store_true")
parser.add_argument("--validate", action="store_true")
options = parser.parse_args(arguments)
OUTPUT.mkdir(parents=True, exist_ok=True)
if options.validate:
    validate_exports()
elif options.turnaround:
    turnaround()
elif options.contact_sheet:
    contact_sheet()
else:
    for character in [options.only] if options.only else SPECS:
        build(character)
    if not options.only:
        contact_sheet()
        turnaround()
