from ultralytics import YOLO
import cv2

stage3 = YOLO(r"C:\Users\PC\Downloads\stage3_v2_best.pt")
crop = cv2.imread("stage3_vert_crop.jpg")

for angle in [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180]:
    test_crop = crop if angle is None else cv2.rotate(crop, angle)
    result = stage3.predict(test_crop, conf=0.01, verbose=False)
    boxes = result[0].boxes
    print(f"\nangle={angle}: {len(boxes)} boxes")
    for box in boxes:
        cls = int(box.cls[0])
        char = stage3.names[cls]
        conf = float(box.conf[0])
        print(f"  {char}  conf={conf:.3f}")