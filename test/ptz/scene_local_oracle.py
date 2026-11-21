"""Independent offline SIFT oracle for saved GB JPEGs. Never uses native H to fit or select points."""
import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np


def read(path):
    return cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mutual_ratio(a,b):
    bf=cv2.BFMatcher()
    def good(left,right):
        return {(m.queryIdx,m.trainIdx):m.distance for m,n in bf.knnMatch(left,right,k=2) if m.distance<.75*n.distance}
    ab,ba=good(a,b),good(b,a)
    return sorted((dist,i,j) for (i,j),dist in ab.items() if (j,i) in ba)


def estimate(ref,current,points,margin,product_points):
    h,w=ref.shape
    assert ref.shape==current.shape
    # Query only local features; search the full target to avoid bias from the tested projection.
    corner=points*np.array([w,h])
    lo,hi=corner.min(axis=0)-margin,corner.max(axis=0)+margin
    mask=np.zeros_like(ref)
    cv2.rectangle(mask,lo.astype(int),hi.astype(int),255,-1)
    sift=cv2.SIFT_create(nfeatures=16000,contrastThreshold=.025)
    k,a=sift.detectAndCompute(ref,mask)
    l,b=sift.detectAndCompute(current,None)
    out=dict(marginPx=margin,referenceKeypoints=len(k),targetKeypoints=len(l),reliable=False)
    if a is None or b is None or min(len(a),len(b))<2:
        return out
    source,target=[],[]
    seen_src,seen_dst=set(),set()
    for _,i,j in mutual_ratio(a,b):
        sp,dp=k[i].pt,l[j].pt
        u,v=tuple(np.rint(sp)),tuple(np.rint(dp))
        if u not in seen_src and v not in seen_dst:
            source.append(sp);target.append(dp);seen_src.add(u);seen_dst.add(v)
    a,b=np.array(source,dtype=np.float64),np.array(target,dtype=np.float64)
    out['uniqueMutualMatches']=len(a)
    if len(a)<24:
        return out
    perm=np.random.default_rng(58173).permutation(len(a))
    train=perm[1:][np.arange(len(perm)-1)%4!=3]
    held=np.setdiff1d(perm,train)
    cv2.setRNGSeed(1337)
    matrix,ok=cv2.findHomography(a[train],b[train],cv2.RANSAC,1.5,maxIters=4000,confidence=.999)
    if matrix is None:
        return out
    def project(values):
        return cv2.perspectiveTransform(values.reshape(-1,1,2),matrix).reshape(-1,2)
    inside=train[ok.ravel().astype(bool)]
    hull=cv2.convexHull(a[inside].astype(np.float32))
    corner_distances=[cv2.pointPolygonTest(hull,tuple(pt),True) for pt in corner]
    covered=min(corner_distances)>=0
    out['signedCornerDistanceToHullPx']=corner_distances
    hold_err=np.linalg.norm(project(a[held])-b[held],axis=1)
    counts=int((hold_err<=2).sum())
    out.update(trainingInliers=len(inside),trainingN=len(train),holdoutN=len(held),holdoutWithin2Px=counts,
        holdoutMedianPx=float(np.median(hold_err)),holdoutP90Px=float(np.quantile(hold_err,.90)),cornerHullCoverage=covered)
    if product_points is not None:
        # Score the displayed polygon against independent held-out in-ROI correspondences.
        # No tested transform participates in descriptor matching, RANSAC or outlier selection.
        keep=[j for j,i in enumerate(held) if hold_err[j]<=2 and
              cv2.pointPolygonTest(corner.astype(np.float32),tuple(a[i]),False)>=0]
        if len(keep)>=6:
            ids=held[keep]
            predicted=cv2.getPerspectiveTransform(corner.astype(np.float32),(product_points*[w,h]).astype(np.float32))
            measured=cv2.perspectiveTransform(a[ids].reshape(-1,1,2),predicted).reshape(-1,2)
            err=np.linalg.norm(measured-b[ids],axis=1)
            out['localHoldoutProductErrorPx']={'n':len(ids),'median':float(np.median(err)),
                'p95':float(np.quantile(err,.95)),'max':float(err.max())}
    if len(inside)>=16 and len(inside)>=.75*len(train) and covered and len(held)>=6 and counts>=.85*len(held):
        out.update(reliable=True,predictedCornersPx=project(corner).tolist(),oracleH=matrix.tolist())
    return out


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference',type=Path)
    parser.add_argument('captures',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('--frame-id',required=True)
    parser.add_argument('--reference-sha256',required=True)
    args=parser.parse_args()
    cv2.setNumThreads(1)
    if digest(args.reference)!=args.reference_sha256:
        raise ValueError('Saved manual reference digest mismatch')
    ref=read(args.reference)
    reports=[]
    for meta in sorted(args.captures.glob('*-capture.json')):
        name=meta.name.removesuffix('-capture.json')
        path=meta.with_name(name+'.jpg')
        if not path.is_file():
            continue
        state=json.loads(meta.read_text())
        rows=[r for r in state['state']['rows'] if r['reference_frame_id']==args.frame_id]
        if len(rows)!=1:
            continue
        row=rows[0]
        # Report both margins, including failures. Widen the reference search only;
        # the independent holdout and convex-hull criteria are identical.
        target=read(path)
        product=np.array(row['current_points']) if row['state']=='matched' and row.get('current_points') else None
        fits=[estimate(ref,target,np.array(row['reference_points']),m,product) for m in (30,80)]
        out=dict(next((f for f in fits if f['reliable']),fits[0]))
        out['marginChecks']=fits
        out.update(name=name,targetSha256=digest(path),state=row['state'],imageAt=state['at'])
        evidence=row.get('evidence') or {}
        if evidence.get('captured_at'):
            dt=lambda s:datetime.fromisoformat(s.replace('Z','+00:00'))
            out['evidenceAt']=evidence['captured_at']
            out['evidenceToJpegSec']=(dt(state['at'])-dt(evidence['captured_at'])).total_seconds()
        if out['reliable'] and row.get('current_points') and row['state']=='matched':
            err=np.array(out['predictedCornersPx'])-np.array(row['current_points'])*[ref.shape[1],ref.shape[0]]
            out['productVsOracleVertexErrorsPx']=np.linalg.norm(err,axis=1).tolist()
        reports.append(out)
    args.output.write_text(json.dumps(dict(referenceSha256=args.reference_sha256,frameId=args.frame_id,
        measurement='1280x960 source pixels; independent local SIFT consensus, asynchronous product observation',cases=reports),indent=2)+'\n')
    for r in reports:
        print(r['name'],r['state'],r.get('uniqueMutualMatches'),r.get('holdoutMedianPx'),r['reliable'],r.get('productVsOracleVertexErrorsPx'))
