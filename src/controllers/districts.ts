import type { Request, Response } from "express";
import { listDistricts } from "../libraries/districts";

export function listDistrictsHandler(_req: Request, res: Response): void {
  res.status(200).json({ districts: listDistricts() });
}
