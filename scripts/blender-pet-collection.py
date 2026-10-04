"""Editable Labora pet collection. Run with Blender 5.2 background Python.

Each pet is real, volumetric geometry. Material textures are packed into .blend
and embedded in GLB. Frames 1, 40, 80 are Rest, Thinking, and Done poses.
"""
import argparse
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/blender/labora-pets-20261004'
CONCEPTS = json.loads((ROOT / 'assets/characters3d/collection-concepts.json').read_text())['concepts']
NAMES = [c['name'].lower() for c in CONCEPTS]
PARTS = []
MOVERS = []
EYES = []
HAPPY = []
MAT = None
DARK = None
CREAM = None
TAU = math.tau

def color(hex):
    c = [int(hex[i:i+2], 16)/255 for i in (0,2,4)]
    return tuple(v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in c)+(1,)

def mat(name, hex, rough=.65, texture=.005, transmission=0, metallic=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = color(hex)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = color(hex)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Transmission Weight'].default_value = transmission
    p.inputs['IOR'].default_value = 1.4
    p.inputs['Subsurface Weight'].default_value = .025 if not transmission else 0
    if rough < .4:
        p.inputs['Coat Weight'].default_value = .22
        p.inputs['Coat Roughness'].default_value = .22
    if texture:
        # Tileable normal texture, embedded in every delivery format.
        n = 256
        rng = np.random.default_rng(sum(map(ord,name)))
        yy,xx = np.mgrid[0:n,0:n]/n*TAU
        h = np.zeros((n,n))
        for k in range(1,30):
            a,b = rng.integers(3,100,2)
            h += np.sin(a*xx+b*yy+rng.random()*TAU) / (8 + k)
        dx = np.roll(h,-1,1)-np.roll(h,1,1)
        dy = np.roll(h,-1,0)-np.roll(h,1,0)
        v = np.stack((-dx*texture*18, -dy*texture*18, np.ones_like(h)), axis=-1)
        v /= np.linalg.norm(v,axis=-1,keepdims=True)
        pixels = np.ones((n,n,4),dtype=np.float32)
        pixels[:,:,:3] = v*.5+.5
        im = bpy.data.images.new(name+' | surface normal',width=n,height=n,alpha=False)
        im.colorspace_settings.name = 'Non-Color'
        im.pixels.foreach_set(pixels.ravel())
        im.pack()
        tex = m.node_tree.nodes.new('ShaderNodeTexImage'); tex.image=im
        normal = m.node_tree.nodes.new('ShaderNodeNormalMap')
        normal.inputs['Strength'].default_value = .24
        m.node_tree.links.new(tex.outputs['Color'],normal.inputs['Color'])
        m.node_tree.links.new(normal.outputs['Normal'],p.inputs['Normal'])
    return m

def select(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0]

def register(o,name,material=None):
    o.name=name
    o['pet_part']=True
    if material: o.data.materials.append(material)
    if o.type=='MESH':
        for p in o.data.polygons: p.use_smooth=True
    PARTS.append(o)
    return o

def mesh(name,vs,fs,material=None):
    data=bpy.data.meshes.new(name); data.from_pydata(vs,[],fs); data.update()
    o=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(o)
    bm=bmesh.new(); bm.from_mesh(data); bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(data); bm.free()
    return register(o,name,material or MAT)

def apply(o):
    select([o]); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)

def ball(name,loc,scale,material=None,segments=40):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=max(16,segments//2),location=loc)
    o=bpy.context.object; o.scale=scale; apply(o)
    return register(o,name,material or MAT)

def box(name,loc,scale,radius=.2,material=None):
    bpy.ops.mesh.primitive_cube_add(size=2,location=loc)
    o=bpy.context.object; o.scale=scale; apply(o)
    b=o.modifiers.new('Rounded edges','BEVEL'); b.width=radius;b.segments=6
    bpy.ops.object.modifier_apply(modifier=b.name)
    n=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=n.name)
    return register(o,name,material or MAT)

def smooth_outline(points,iterations=3):
    for _ in range(iterations):
        points=[((1-t)*p[0]+t*q[0],(1-t)*p[1]+t*q[1]) for p,q in zip(points,points[1:]+points[:1]) for t in (.2,.8)]
    return points

def pillow(name,points,depth=.65,center=(0,1.1),smooth=3):
    points=smooth_outline(points,smooth)
    vs=[];fs=[]; n=len(points); rings=40
    for j in range(1,rings):
        t=math.pi*j/rings; s=math.sin(t)
        for x,z in points:
            vs.append((center[0]+(x-center[0])*s, -depth*math.copysign(math.sqrt(max(0,1-s**2.7)),math.cos(t)),center[1]+(z-center[1])*s))
    for j in range(rings-2):
        for i in range(n): fs.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    for j,y in [(0,-depth),(rings-2,depth)]:
        p=len(vs);vs.append((center[0],y,center[1]))
        for i in range(n):fs.append((p,j*n+i,j*n+(i+1)%n))
    o=mesh(name,vs,fs)
    select([o]);sub=o.modifiers.new('Rounded sculpt surface','SUBSURF');sub.levels=1;bpy.ops.object.modifier_apply(modifier=sub.name)
    return o

def tube(name,points,radius=.12,material=None,radii=None,closed=False):
    data=bpy.data.curves.new(name,'CURVE');data.dimensions='3D';data.resolution_u=10
    data.bevel_depth=radius;data.bevel_resolution=4;data.use_fill_caps=True
    sp=data.splines.new('BEZIER');sp.bezier_points.add(len(points)-1)
    for i,(bp,p) in enumerate(zip(sp.bezier_points,points)):
        bp.co=p;bp.handle_left_type=bp.handle_right_type='AUTO';bp.radius=radii[i] if radii else 1
    sp.use_cyclic_u=closed
    o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o)
    return register(o,name,material or MAT)

def convert(o):
    if o.type=='CURVE':
        ends=[]
        if o.data.bevel_depth>.04:
            for sp in o.data.splines:
                if not sp.use_cyclic_u and sp.type=='BEZIER':
                    for bp in (sp.bezier_points[0],sp.bezier_points[-1]):
                        ends.append((o.matrix_world@bp.co,o.data.bevel_depth*bp.radius))
        material=o.data.materials[0] if o.data.materials else MAT
        select([o]);bpy.ops.object.convert(target='MESH')
        caps=[ball('Rounded end',p,(r,r,r),material,16) for p,r in ends]
        if caps:
            for cap in caps:PARTS.remove(cap)
            select([o,*caps]);bpy.ops.object.join()
    return o

def union(name,objs,voxel=.045):
    for o in objs:convert(o)
    select(objs);bpy.ops.object.join();o=bpy.context.object;o.name=name
    for old in objs[1:]:
        if old in PARTS:PARTS.remove(old)
    mod=o.modifiers.new('Sculpted union','REMESH');mod.mode='VOXEL';mod.voxel_size=voxel;mod.use_smooth_shade=True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    sm=o.modifiers.new('Clay smoothing','SMOOTH');sm.factor=1.25;sm.iterations=5;bpy.ops.object.modifier_apply(modifier=sm.name)
    sub=o.modifiers.new('Sculpt surface','SUBSURF');sub.levels=1;bpy.ops.object.modifier_apply(modifier=sub.name)
    o.data.materials.clear();o.data.materials.append(MAT)
    return o

def uv(o):
    if o.type!='MESH' or o.data.uv_layers:return
    select([o]);bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.15,island_margin=.02)
    bpy.ops.object.mode_set(mode='OBJECT')

def sy(body,x,z):
    bpy.context.view_layer.update()
    inv=body.matrix_world.inverted()
    hit,p,_,_=body.ray_cast(inv@Vector((x,-10,z)),(inv.to_3x3()@Vector((0,1,0))).normalized())
    if not hit:raise RuntimeError(f'Face missed {body.name}: {x}, {z}')
    return (body.matrix_world@p).y

def eye(body,x,z,size=.075,style='dot',tilt=0):
    y=sy(body,x,z)
    if style in ('white','sleepy'):
        sclera=ball('Eye | ivory socket',(x,y-.018,z),(size*1.42,.046,size*1.8),CREAM)
        EYES.append(sclera)
        pupil=ball('Eye | dark pupil',(x+size*.30,y-.058,z+size*.4),(size*.84,.036,size*1.2),DARK)
        EYES.append(pupil)
        if style=='sleepy':
            lid=ball('Eye | sleepy upper lid',(x,y-.04,z+size*.85),(size*1.6,.061,size*.88),MAT)
            EYES.append(lid)
    else:
        o=ball('Eye | black bead',(x,y-.015,z),(size,.048,size*(1.4 if style=='oval' else 1.05)),DARK)
        o.rotation_euler.y=tilt;EYES.append(o)
    happy=tube('Expression | smiling eye',[(x-size,y-.045,z),(x,y-.075,z+size*.7),(x+size,y-.045,z)],.020,DARK)
    convert(happy);HAPPY.append(happy)

def face(body,z=1.1,spacing=.25,size=.075,style='dot',slope=0):
    for x in (-spacing,spacing):eye(body,x,z+x*slope,size,style)

def brow(body,x,z,material=None,slant=0):
    return tube('Brow',[(x-.11,sy(body,x-.11,z)-.028,z-slant),(x,sy(body,x,z+.03)-.035,z+.04),(x+.11,sy(body,x+.11,z)-.028,z+slant)],.037,material or MAT)

def mouth(body,x,z,kind='smile'):
    if kind=='o':return ball('Mouth | small O',(x,sy(body,x,z)-.017,z),(.047,.022,.065),DARK)
    return tube('Mouth | smile',[(x-.09,sy(body,x-.09,z)-.02,z),(x,sy(body,x,z-.035)-.021,z-.035),(x+.09,sy(body,x+.09,z)-.02,z+.015)],.014,DARK)

def feet(xs=(-.5,.5),z=.17,scale=(.24,.32,.18),material=None):
    return [ball('Foot '+str(i),(x,-.04,z+.075),(scale[0],scale[1],scale[2]+.025),material) for i,x in enumerate(xs)]

def arms(xs=(-.8,.8),z=.5,material=None):
    obs=[]
    for x in xs:
        o=ball('Arm '+('L' if x<0 else 'R'),(x,-.38,z),(.19,.20,.30),material)
        o.rotation_euler.y=-.3 if x<0 else .3;MOVERS.append(o);obs.append(o)
    return obs

def fur(body,material,count=6000,length=.026):
    rng=random.Random(39)
    bm=bmesh.new();bm.from_mesh(body.data);bvh=BVHTree.FromBMesh(bm)
    vs=[];fs=[]
    center=sum((v.co for v in body.data.vertices),Vector())/len(body.data.vertices)
    for _ in range(count):
        n=Vector((rng.uniform(-1,1),rng.uniform(-1,1),rng.uniform(-1,1))).normalized()
        p,normal,_,_=bvh.ray_cast(center+n*5,-n)
        if p is None:continue
        wp=body.matrix_world@p
        if any(abs(wp.y-e.location.y)<.15 and (wp.x-e.location.x)**2+(wp.z-e.location.z)**2<.016 for e in EYES):continue
        t=normal.cross(Vector((0,0,1)))
        if t.length<.01:t=normal.cross(Vector((0,1,0)))
        t.normalize();s=normal.cross(t)
        base=len(vs);l=length*rng.uniform(.5,1.6)
        for j in range(3):
            c=p+normal*(l*j/2-.002)+t*(.007*j*j)
            for k in range(3):vs.append(tuple(c+.0014*(math.cos(k*TAU/3)*t+math.sin(k*TAU/3)*s)))
        for j in range(2):
            for k in range(3):fs.append((base+j*3+k,base+j*3+(k+1)%3,base+(j+1)*3+(k+1)%3,base+(j+1)*3+k))
        fs.extend([(base+2,base+1,base),(base+6,base+7,base+8)])
    bm.free();o=mesh('Felt | solid fibres',vs,fs,material);o.matrix_world=body.matrix_world.copy();return o

def moss_coat(body):
    rng=random.Random(73);vs=[];fs=[]
    bm=bmesh.new();bm.from_mesh(body.data);bvh=BVHTree.FromBMesh(bm)
    center=Vector((0,0,1.05))
    for _ in range(7200):
        d=Vector((rng.uniform(-1,1),rng.uniform(-1,1),rng.uniform(-1,1))).normalized()
        p,n,_,_=bvh.ray_cast(center+d*5,-d)
        if p is None:continue
        if p.y<-.25 and (p.x/.42)**2+((p.z-1.19)/.22)**2<1:continue
        tangent=n.cross(Vector((0,0,1)))
        if tangent.length<.01:tangent=n.cross(Vector((0,1,0)))
        tangent.normalize();other=n.cross(tangent)
        size=rng.uniform(.018,.032);base=len(vs)
        # Closed wool loops. The high relief survives the portable mesh export.
        for j in range(8):
            a=j*TAU/8;c=p+n*(.021+size*math.sin(a))+tangent*(size*math.cos(a))
            out=(n*math.sin(a)+tangent*math.cos(a))
            for k in range(4):vs.append(tuple(c+.009*(out*math.cos(k*TAU/4)+other*math.sin(k*TAU/4))))
        for j in range(8):
            for k in range(4):fs.append((base+j*4+k,base+j*4+(k+1)%4,base+(j+1)%8*4+(k+1)%4,base+(j+1)%8*4+k))
    bm.free();return mesh('Boucle | 7200 closed wool loops',vs,fs,MAT)

def make_leaf():
    outline=[(-.22,1.81),(-.41,2.22),(-.30,2.58),(.05,2.77),(.53,2.77),(.96,2.42),(1.13,1.90),(.84,2.06),(.48,2.25),(.08,2.40),(-.13,2.25)]
    o=pillow('Leaf | curled blade',outline,.10,center=(.28,2.48),smooth=3)
    for v in o.data.vertices:v.co.y-=.28*(v.co.x+.3)
    MOVERS.append(o)
    veinmat=mat('Leaf vein','9AA35F',.82,.008)
    points=[(-.18,2.24),(-.13,2.51),(.18,2.64),(.58,2.50),(.92,2.18)]
    tube('Leaf | center vein',[(x,sy(o,x,z)-.010,z) for x,z in points],.012,veinmat)
    return o

def cup_ear(name,center,scale,angle):
    o=ball(name,(0,0,0),(1,1,1),segments=64)
    front=[v.co.y for v in o.data.vertices]
    ear_material=MAT.copy();ear_material.name=name+' | clay tint';o.data.materials[0]=ear_material
    tint=o.data.color_attributes.new(name='Ear tint',type='FLOAT_COLOR',domain='POINT')
    outer=color('8CA0B7');inner=color('637B97')
    for i,y in enumerate(front):
        t=max(0,min(1,(-y-.28)/.42));t=t*t*(3-2*t)
        tint.data[i].color=tuple(outer[k]*(1-t)+inner[k]*t for k in range(4))
    node=ear_material.node_tree.nodes.new('ShaderNodeVertexColor');node.layer_name='Ear tint'
    ear_material.node_tree.links.new(node.outputs['Color'],ear_material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    for v in o.data.vertices:
        x,y,z=v.co
        v.co=(x*scale[0], y*scale[1]+(.46*(1-x*x-z*z) if y<0 else 0),z*scale[2])
    o.location=center;o.rotation_euler.y=angle;MOVERS.append(o);return o

def bell(name,ghost=False):
    vs=[];fs=[];n=96;rows=40
    for j in range(rows):
        t=j/(rows-1);z=.25+t*2.0
        r=(1-t**1.8)**.52*(.88+.13*math.exp(-t*15))
        if ghost:r=(1-t)**.48*(.94+.08*math.cos(t*math.pi))
        for i in range(n):
            a=i*TAU/n;wave=math.cos(a*7)*.065*math.exp(-t*7)
            vs.append((r*math.cos(a)+(.3*t**3 if ghost else 0),r*.67*math.sin(a),z+wave))
    for j in range(rows-1):
        for i in range(n):fs.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    for j,z in [(0,.27),(rows-1,2.25)]:
        k=len(vs);vs.append((.3 if ghost and j else 0,0,z))
        for i in range(n):fs.append((k,j*n+i,j*n+(i+1)%n))
    return mesh(name,vs,fs)

def model(name):
    global MAT,DARK,CREAM
    specs={
      'scout':('F5BF35',.7,.008),'dozer':('CDBDA3',.95,.04),'pip':('B9BE79',.8,.02),
      'mochi':('DED0E4',.78,.005),'nib':('172643',.33,.009),'crumb':('D98950',.87,.026),
      'moss':('788044',.95,.035),'pocket':('D58474',.94,.035),'tumble':('F4CD58',.8,.012),
      'peb':('7B8795',.8,.021),'flick':('F6AA39',.46,.014),'loop':('F2B18A',.92,.025),
      'jelly':('A5D5D6',.23,.003),'orbit':('9492CE',.84,.012),'echo':('8CA0B7',.83,.025),
      'wisp':('F3E6D0',.31,.006),'knob':('E7B637',.65,.01),'sprig':('EE8B78',.65,.013),
      'puff':('B8D3E8',.95,.033),'rook':('494443',.84,.018),'marble':('EEE0CA',.24,.004),
      'noodle':('F79A48',.71,.013),'patch':('A7AE91',.95,.038),'dimple':('BF6370',.78,.011)}
    c,r,t=specs[name];MAT=mat(name+' | body',c,r,t,.42 if name=='jelly' else .32 if name=='marble' else 0)
    DARK=mat('Espresso eyes','28201D',.27,0)
    CREAM=mat('Warm ivory','F0E4CC',.55,.003)
    if name=='scout':
        p=[(-.05,2.25),(.38,2.72),(.65,2.79),(.80,2.59),(.87,2.25),(.68,2.12),(.47,2.28),(.97,1.65),(1.43,1.27),(.78,1.02),(.85,.05),(.56,.03),(-.04,.40),(-.83,.02),(-1.03,.15),(-.73,1.01),(-1.40,1.57),(-1.35,1.81),(-.53,1.84)]
        b=pillow('Body | asymmetrical bent star',p,.55,center=(0,1.25),smooth=2)
        face(b,1.39,.25,.077,'oval',.15);brow(b,.25,1.59,slant=.015)
    elif name=='dozer':
        b=pillow('Body | sleepy bean',[(-1.14,.16),(-1.23,.7),(-1,1.6),(-.45,1.96),(.45,1.92),(.85,1.3),(1.17,.12)],.67,center=(0,1))
        face(b,.99,.34,.1,'sleepy',.12);mouth(b,0,.77)
        fold=tube('Blanket | folded corner',[(-.16,0,1.87),(.40,-.32,1.88),(.69,-.50,1.58),(.97,-.37,1.14)],.13,radii=[.7,1.2,1.8,.4]);MOVERS.append(fold)
        arms((-.73,.71),.3);fur(b,MAT,8500,.032)
    elif name=='pip':
        b=pillow('Body | seed',[(-.85,.22),(-1,1),(-.55,1.65),(0,1.87),(.65,1.65),(.94,.7),(.65,.2)],.60,center=(0,.98))
        face(b,1.1,.29,.075)
        rootmat=mat('Root feet','B89970',.85,.02);feet((-.49,.49),.13,(.17,.32,.14),rootmat)
        tube('Stem',[(-.05,0,1.65),(-.29,0,2.11),(-.1,-.04,2.18)],.11)
        leafmat=mat('Leaf green','899855',.8,.022);old=MAT;MAT=leafmat;make_leaf();MAT=old
    elif name=='mochi':
        b=pillow('Body | soft rice cake',[(-1.1,.12),(-1.18,.65),(-.93,1.5),(-.45,1.96),(.45,1.96),(.95,1.5),(1.14,.10)],.69,center=(0,1))
        face(b,1.13,.31,.072,'oval');arms((-.98,.98),.74)
        blush=mat('Rosy cheeks','EAB0C4',.91,.005)
        for x in (-.48,.48):ball('Cheek',(x,sy(b,x,.94)-.007,.94),(.14,.012,.078),blush)
    elif name=='nib':
        b=pillow('Body | ink droplet',[(-.88,.17),(-1.05,.71),(-.85,1.36),(-.43,1.8),(-.12,2.27),(.13,2.36),(.29,1.79),(.83,1.29),(1,.32),(.5,.08)],.74,center=(0,1.08))
        curl=tube('Crown | curled ink',[(-.25,0,1.92),(-.02,0,2.48),(.43,0,2.60),(.72,0,2.35),(.58,0,2.08),(.42,0,2.21),(.59,0,2.24)],.18,radii=[1.9,1.6,1.2,.85,.5,.32,.05])
        b=union('Body | continuous ink curl',[b,curl],.034)
        face(b,1.11,.33,.13,'white',.13);brow(b,-.35,1.45,DARK,.06);feet((-.57,.57),.15,(.26,.34,.17));ball('Tail',(-.9,.37,.42),(.30,.28,.38))
    elif name=='crumb':
        b=pillow('Body | chipped biscuit',[(-.95,.51),(-1.1,1.3),(-.6,1.99),(.3,2.36),(.39,2.08),(.57,1.98),(.56,1.78),(.77,1.70),(1.02,1.82),(1.03,1.37),(.80,.27),(.38,.09),(-.31,.31)],.52,center=(0,1.17),smooth=1)
        eye(b,-.28,1.28,.11);eye(b,.30,1.16,.071);feet((-.59,),.14,(.24,.3,.16))
        speckle=mat('Baked flecks','9B633D',.94,0)
        rng=random.Random(22)
        for i in range(100):
            x=rng.uniform(-.8,.8);z=rng.uniform(.35,2.1)
            try:y=sy(b,x,z)
            except RuntimeError:continue
            ball('Crumb fleck',(x,y-.002,z),(rng.uniform(.006,.015),.007,rng.uniform(.007,.016)),speckle,8)
    elif name=='moss':
        b=pillow('Body | moss mound',[(-1.02,.2),(-1.1,.8),(-.65,1.7),(-.08,2.09),(.46,1.87),(.85,1.1),(1.0,.17)],.66,center=(0,1.05))
        moss_coat(b);fur(b,MAT,5000,.035);face(b,1.2,.22,.079);feet((-.55,.55),.12,(.23,.30,.13))
        for x in (-.4,.4):
            paw=ball('Moss mitten',(x,-.6,.68),(.25,.20,.25));MOVERS.append(paw);fur(paw,MAT,600,.02)
    elif name=='pocket':
        b=box('Body | felt pouch',(0,0,1.05),(.91,.47,.85),.30)
        face(b,1.1,.29,.08,'oval',.17);feet((-.61,.61),.17,(.22,.24,.18))
        flap=pillow('Flap | diagonal fold',[(-.92,1.9),(.65,1.9),(-.89,.98)],.095,center=(-.39,1.57),smooth=2);flap.location.y=-.48;MOVERS.append(flap)
        ear=pillow('Corner | folded ear',[(.52,1.8),(.93,2.18),(1.01,1.39)],.13,center=(.83,1.8),smooth=2)
        tube('Flap | seam',[(-.80,-.575,1.78),(-.79,-.60,1.14),(.46,-.58,1.79)],.008,MAT)
        fur(b,MAT,7000,.021);fur(flap,MAT,1200,.016)
    elif name=='tumble':
        b=box('Body | tumbling cube',(0,0,1.22),(.86,.70,.86),.27)
        b.rotation_euler.y=.31;b.rotation_euler.z=-.09
        select([b]);bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
        face(b,.87,.24,.077,'oval',-.3)
    elif name=='peb':
        b=pillow('Body | river stone',[(-.91,.36),(-.96,1.05),(-.45,1.92),(.2,2.29),(.56,2.15),(.92,1.1),(.86,.3),(.01,.18)],.61,center=(0,1.2))
        face(b,1.42,.29,.077,'dot',.36);brow(b,-.29,1.50,slant=.025);brow(b,.29,1.75,slant=-.02);feet((-.48,.48),.17,(.28,.29,.18))
        quartz=mat('Quartz seam','DBCCAF',.7,.014)
        pts=[]
        for i in range(35):
            z=.23+i/34*1.91;x=-.17+.73*math.sin((z-.20)*1.12)
            try:pts.append((x,sy(b,x,z)-.008,z))
            except RuntimeError:pass
        tube('Quartz | continuous vein',pts,.038,quartz)
    elif name=='flick':
        b=pillow('Body | flame belly',[(-.85,.12),(-1.02,.65),(-.65,1.58),(0,1.8),(.73,1.53),(.91,.1)],.56,center=(0,.91))
        flames=[tube('Flame center',[(0,.08,1.20),(-.16,.02,2.02),(.33,.03,2.46),(.51,.02,2.78),(.35,.02,2.83)],.30,radii=[2,1.45,1,.37,.04]),tube('Flame left',[(-.64,.05,.9),(-.98,.05,1.64),(-.93,.02,2.11),(-1.04,.02,2.28)],.22,radii=[1.5,1.1,.6,.05]),tube('Flame right',[(.64,.1,.9),(.95,.02,1.52),(.79,.02,1.93),(.88,.02,2.16)],.22,radii=[1.5,1.2,.7,.06])]
        b=union('Body | three wax flames',[b,*flames],.038)
        face(b,.94,.29,.095,'oval',.22);mouth(b,0,.70);brow(b,-.29,1.23,DARK,-.045);brow(b,.29,1.35,DARK,.08);arms((-.70,.70),.30)
    elif name=='loop':
        path=[(-.62*math.cos(i/32*math.pi),0,.30+1.64*math.sin(i/32*math.pi)) for i in range(33)]
        b=convert(tube('Body | knitted arch',path,.33))
        # Surface stitches follow the evaluated arch along both tube directions.
        centerpath=[]
        for i in range(90):
            t=i/89*math.pi
            centerpath.append(Vector((-.62*math.cos(t),0,.30+1.64*math.sin(t))))
        stitches=[]
        for i in range(0,88,2):
            p=centerpath[i];q=centerpath[i+2];tangent=(q-p).normalized();side=Vector((0,-1,0));radial=tangent.cross(side).normalized()
            for j in range(14):
                a=j*TAU/14;n=side*math.cos(a)+radial*math.sin(a);binormal=-side*math.sin(a)+radial*math.cos(a)
                c=(p+q)/2+n*.336
                stitches.append(tube('Knit stitch',[tuple(c-tangent*.040-binormal*.043),tuple(c+tangent*.048+n*.014),tuple(c-tangent*.040+binormal*.043)],.018))
        for o in stitches:convert(o)
        for o in stitches[1:]:PARTS.remove(o)
        select(stitches);bpy.ops.object.join();w=bpy.context.object;w.name='Knit | interlocking V stitches'
        eye(b,-.31,1.89,.075);eye(b,.32,1.78,.075)
        for o in EYES+HAPPY:o.location.y-=.065
        for x in (-.62,.62):ball('Knit | rounded foot',(x,0,.30),(.33,.33,.22))
    elif name=='jelly':
        b=bell('Body | scalloped jelly');face(b,1.37,.30,.092,'oval');mouth(b,0,1.11,'o');feet((-.5,.5),.20,(.25,.28,.22))
    elif name=='orbit':
        b=ball('Body | little planet',(0,0,1.18),(.94,.84,.94));face(b,1.54,.28,.086,'white');mouth(b,.04,1.28,'o');feet((-.53,.53),.16,(.18,.26,.19))
        peach=mat('Orbit | peach','EDB393',.78,.013)
        ring=tube('Ring | open orbit',[(-.63,.03,2.27),(-1.1,-.15,2.13),(-1.13,-.65,1.70),(-.61,-1.01,1.17),(.30,-.98,.91),(1.03,-.52,.98),(.95,.22,1.42)],.145,peach,radii=[.7,1.1,1.12,1,1,.8,.45]);MOVERS.append(ring)
    elif name=='echo':
        b=pillow('Body | listening bean',[(-.67,.18),(-.78,.8),(-.3,1.78),(.24,1.85),(.75,.87),(.64,.12)],.52,center=(0,.92));face(b,1.27,.21,.065);feet((-.48,.48),.17,(.22,.29,.20))
        cup_ear('Ear L | cupped and drooped',(-.64,.05,2.01),(.42,.25,.70),-.85)
        cup_ear('Ear R | upright cup',(.46,.05,2.28),(.42,.25,.86),-.20)
    elif name=='wisp':
        b=bell('Body | porcelain drape',True);face(b,1.35,.28,.072,'oval',-.10)
        arm=ball('Arm | raised drape',(-.83,-.06,.93),(.20,.30,.46));arm.rotation_euler.y=-.38;MOVERS.append(arm)
    elif name=='knob':
        b=pillow('Body | stubborn triangle',[(-1.11,.27),(-.99,.95),(-.24,2.21),(.24,2.26),(.90,1.12),(1.12,.24)],.62,center=(0,1.03))
        face(b,1.27,.25,.085);brow(b,-.25,1.43,slant=-.065);brow(b,.25,1.43,slant=.065)
        k=box('Crown | offset knob',(.40,.02,2.02),(.20,.20,.25),.10);k.rotation_euler.y=-.24;MOVERS.append(k)
        feet((-.78,.78),.17,(.29,.37,.19))
    elif name=='sprig':
        b=union('Body | branching coral',[tube('Trunk',[(-.17,0,.23),(0,0,.8),(0,0,1.60)],.28,radii=[1,1.15,1.4]),tube('Branch L',[(0,0,1.35),(-.53,0,1.86),(-.83,0,2.24)],.27,radii=[1.2,1,1.35]),tube('Branch R',[(0,0,1.38),(.53,0,1.96),(.69,0,2.48)],.28,radii=[1.3,1,1.3]),ball('Foot L',(-.20,0,.21),(.27,.31,.23)),ball('Foot R',(.22,0,.21),(.25,.31,.23))],.035)
        face(b,1.28,.18,.066,'oval',.12)
        arm=tube('Branch | hand on hip',[(.19,.03,1.05),(.68,.03,.96),(.65,.03,.61),(.24,.03,.56)],.13);MOVERS.append(arm)
    elif name=='puff':
        b=union('Body | three cloud lobes',[ball('Cloud left',(-.63,0,.77),(.57,.58,.62)),ball('Cloud center',(0,0,1.22),(.62,.66,.85)),ball('Cloud right',(.62,0,.77),(.59,.57,.61))],.034)
        face(b,1.13,.30,.077);feet((-.36,.36),.13,(.17,.23,.14),mat('Cloud feet','A8A29C',.9,.026));fur(b,MAT,11000,.036)
        blush=mat('Cloud blush','EBC3C1',.94,.02)
        for x in (-.45,.45):ball('Cheek',(x,sy(b,x,.91)-.009,.91),(.11,.014,.075),blush)
    elif name=='rook':
        b=union('Body | tower crown',[pillow('Tower',[(-.82,.18),(-.64,1.41),(-.73,1.90),(.74,1.93),(.65,1.38),(.85,.18)],.54,center=(0,1)),box('Crown L',(-.57,0,2.03),(.32,.43,.40),.15),box('Crown R',(.57,0,2.03),(.32,.43,.40),.15)],.04)
        face(b,1.39,.29,.13,'white');feet((-.58,.58),.15,(.30,.32,.18))
    elif name=='marble':
        b=ball('Body | opaline marble',(0,0,1.18),(.99,.90,.99),segments=64)
        face(b,1.2,.35,.085,'dot',.58);feet((-.49,.49),.13,(.19,.25,.17))
        pink=mat('Rose suspended in glass','E7BBAF',.3,.003,transmission=.15)
        pts=[]
        for i in range(45):
            z=.37+i/44*1.65;x=.22*math.sin((z-.4)*4)-.18
            pts.append((x,sy(b,x,z)+.025,z))
        tube('Glass | rose swirl',pts,.061,pink,radii=[.3+.7*math.sin(i/44*math.pi) for i in range(45)])
    elif name=='noodle':
        path=[(-.83,.15,.24),(-.63,.12,.37),(.20,.16,1.58),(.64,.03,2.01),(.94,-.10,1.63),(.79,-.30,1.02),(.06,-.48,.64),(-.78,-.46,.99),(-.92,-.24,1.44),(-.64,.02,1.72),(-.07,.20,1.43),(.55,.28,.73),(.85,.20,.23)]
        b=convert(tube('Body | continuous pretzel cord',path,.25,radii=[1.1,1,1,1.04,1.07,1.08,1.07,1.05,1.05,1,1,1,1.15]))
        for p in (path[0],path[-1]):ball('Cord | rounded foot end',p,(.275,.27,.255))
        eye(b,.80,1.78,.071);eye(b,1.03,1.62,.071)
    elif name=='patch':
        b=pillow('Body | diamond cushion',[(0,2.27),(1.14,1.17),(.15,.10),(-1.13,.95)],.54,center=(0,1.12),smooth=3)
        face(b,1.42,.29,.064,'dot',.15);feet((-.39,.39),.15,(.19,.23,.16))
        old=MAT;MAT=mat('Oatmeal patch','D7C3A0',.94,.03)
        p=ball('Patch | sewn oatmeal panel',(.51,-.42,.58),(.36,.12,.30));p.rotation_euler.y=-.55
        for i in range(12):
            a=TAU*i/12;x=.51+.34*math.cos(a);z=.58+.28*math.sin(a)
            tube('Patch | stitch',[(x-.033*math.cos(a),-.54,z-.042*math.sin(a)),(x+.043*math.cos(a),-.56,z+.045*math.sin(a))],.016,CREAM)
        MAT=old;fur(b,MAT,9000,.028)
    elif name=='dimple':
        b=pillow('Body | dimpled pillow',[(-1.04,.25),(-1.14,1.08),(-.65,1.96),(.16,2.02),(.79,1.8),(.95,2.10),(1.08,1.68),(.91,1.23),(1.03,.37),(.53,.11)],.68,center=(0,1.12),smooth=3)
        for v in b.data.vertices:
            x,y,z=v.co
            if y<0:v.co.y += .53*math.exp(-((x-.12)/.37)**2-((z-1.02)/.4)**2)*min(1,-y/.3)
        face(b,1.47,.23,.086,'sleepy',.10);feet((-.64,.62),.14,(.25,.28,.14))
    else:raise ValueError(name)
    return b

def stage(size=720):
    scene=bpy.context.scene
    world=bpy.data.worlds.new('Warm studio');world.use_nodes=True
    world.node_tree.nodes['Background'].inputs[0].default_value=(.85,.82,.76,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.75;scene.world=world
    floor_mat=mat('Stage | warm paper','F9EFDC',.86,0)
    fp=floor_mat.node_tree.nodes.get('Principled BSDF');fp.inputs['Emission Color'].default_value=color('F9EFDC');fp.inputs['Emission Strength'].default_value=.12
    bpy.ops.mesh.primitive_plane_add(size=200);floor=bpy.context.object;floor.name='STUDIO | ground';floor.data.materials.append(floor_mat);floor.location.z=-.025
    for name,loc,power,sz in [('Key',(-3,-4,6),500,4),('Fill',(4,-2,4),260,3),('Rim',(1,3,5),450,3)]:
        bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.name='STUDIO | '+name;o.data.energy=power;o.data.shape='DISK';o.data.size=sz;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.camera_add(location=(3.3,-10,3.5));cam=bpy.context.object;cam.name='STUDIO | portrait';cam.rotation_euler=(Vector((0,0,1.3))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=3.6;scene.camera=cam
    scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True
    scene.render.resolution_x=scene.render.resolution_y=size;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast'
    try:
        prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='METAL';prefs.get_devices()
        for d in prefs.devices:d.use=d.type=='METAL'
        if any(d.type=='METAL' for d in prefs.devices):scene.cycles.device='GPU'
    except Exception:pass
    return scene

def expressions(root,name):
    scene=bpy.context.scene;scene.frame_start=1;scene.frame_end=100;scene.render.fps=24
    for f,title in [(1,'Rest'),(40,'Thinking'),(80,'Done')]:scene.timeline_markers.new(title,frame=f)
    for o in EYES:
        for f,s in [(1,1),(40,1),(60,1),(68,.001),(100,.001)]:o.scale=(s,s,s);o.keyframe_insert(data_path='scale',frame=f)
    for o in HAPPY:
        for f,s in [(1,.001),(60,.001),(68,1),(100,1)]:o.scale=(s,s,s);o.keyframe_insert(data_path='scale',frame=f)
    for f,lean,z,stretch in [(1,0,0,1),(26,.02,0,1),(40,-.11,0,.97),(56,-.09,0,.98),(68,.06,.10,1.02),(80,.08,.19,.97),(94,0,0,1),(100,0,0,1)]:
        root.rotation_euler.y=lean;root.location.z=z;root.scale=(1/stretch,1,stretch)
        for prop in ['rotation_euler','location','scale']:root.keyframe_insert(data_path=prop,frame=f)
    for i,o in enumerate(MOVERS):
        base=o.rotation_euler.copy();location=o.location.copy()
        for f,angle,z in [(1,0,0),(40,(-.13 if i%2 else .13),.08),(80,(.22 if i%2 else -.22),.13),(100,0,0)]:
            o.rotation_euler=base.copy();o.rotation_euler.y+=angle;o.location=location+Vector((0,0,z))
            o.keyframe_insert(data_path='rotation_euler',frame=f);o.keyframe_insert(data_path='location',frame=f)
    scene.frame_set(1)

def metrics():
    count=tri=verts=0;bounds=[]
    for o in PARTS:
        if o.type!='MESH':continue
        count+=1;o.data.calc_loop_triangles();tri+=len(o.data.loop_triangles);verts+=len(o.data.vertices)
        bounds += [o.matrix_world@Vector(p) for p in o.bound_box]
    return {'meshes':count,'vertices':verts,'triangles':tri,'bounds':{'min':[min(p[i] for p in bounds) for i in range(3)],'max':[max(p[i] for p in bounds) for i in range(3)]}}

def build(name,size=720):
    global PARTS,MOVERS,EYES,HAPPY
    bpy.ops.wm.read_factory_settings(use_empty=True);PARTS=[];MOVERS=[];EYES=[];HAPPY=[]
    random.seed(24);index=NAMES.index(name)+1;directory=OUT/f'{index:02d}-{name}';directory.mkdir(parents=True,exist_ok=True)
    body=model(name)
    for o in PARTS:convert(o);uv(o)
    bpy.ops.object.empty_add(type='PLAIN_AXES');root=bpy.context.object;root.name=name.title()+' | pose root';root['pet_root']=True
    for o in PARTS:o.parent=root;o['character']=name
    bpy.context.view_layer.update()
    lowest=min((o.matrix_world@v.co).z for o in PARTS for v in o.data.vertices)
    for o in PARTS:o.location.z -= lowest
    expressions(root,name)
    bpy.context.view_layer.update();data=metrics();data.update({'name':name,'id':index,'blender':bpy.app.version_string,'poses':{'rest':1,'thinking':40,'done':80}})
    collection=bpy.data.collections.new(f'{index:02d} {name.title()}');bpy.context.scene.collection.children.link(collection)
    for o in [root,*PARTS]:
        for c in list(o.users_collection):c.objects.unlink(o)
        collection.objects.link(o)
    select([root,*PARTS])
    bpy.ops.export_scene.gltf(filepath=str(directory/f'{name}.glb'),export_format='GLB',use_selection=True,export_apply=False,export_animations=True,export_animation_mode='SCENE',export_frame_range=True,export_cameras=False,export_lights=False,export_extras=True)
    scene=stage(size)
    height=data['bounds']['max'][2];width=data['bounds']['max'][0]-data['bounds']['min'][0]
    target=Vector((0,0,height*.50))
    scene.camera.location=target+Vector((3.3,-10,2.1))
    scene.camera.rotation_euler=(target-scene.camera.location).to_track_quat('-Z','Y').to_euler()
    scene.camera.data.ortho_scale=max(height+.85,width+.85,3.1)
    # A packed concept image is an editing reference only. It is never model geometry.
    ref=ROOT/f'output/imagegen/labora-pets-20261004/{index:02d}-{name}.png'
    if ref.exists():
        image=bpy.data.images.load(str(ref));image.pack()
    note=bpy.data.texts.new('READ ME')
    note.write(f'{name.title()} | Labora\nOriginal concept: {ref.name}\nFront is -Y, up is +Z. All character parts are editable meshes.\nTimeline: frame 1 rest, 40 thinking, 80 done. Object animation, no skeletal rig.\nThe concept image is packed for reference only.\nGLB embeds materials, normal maps, and the pose timeline.\n')
    for area in bpy.context.screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'
    select([body]);scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(directory/f'{name}.blend'),compress=True)
    for pose,frame in [('preview',1),('thinking',40),('done',80)]:
        scene.frame_set(frame);scene.render.filepath=str(directory/f'{pose}.png');bpy.ops.render.render(write_still=True)
    (directory/'metrics.json').write_text(json.dumps(data,indent=2))
    print('PET_COMPLETE '+name+' '+str(data['triangles']),flush=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('--only',nargs='+');p.add_argument('--size',type=int,default=720)
    args=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    for name in args.only or NAMES:build(name,args.size)

if __name__=='__main__':main()
